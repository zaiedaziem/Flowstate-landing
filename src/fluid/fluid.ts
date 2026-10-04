/*
 * Flowstate fluid — a TypeScript port of Pavel Dobryakov's WebGL fluid
 * simulation (MIT), as tuned in SPEC.md.
 *
 * The solver, shaders, config, load burst, colour band and orbiting
 * auto-cursor are unchanged from the spec. Everything added here is
 * lifecycle around it:
 *   - devicePixelRatio is capped (default 1.5); all simulation maths runs in
 *     CSS pixels so the look is identical at any DPR
 *   - pause / resume (tab hidden, canvas off-screen), destroy
 *   - setQuality(tier) + automatic step-down when frames run slow
 *   - reduced-motion "static" mode: simulate a short burst, render one calm
 *     frame, stop
 *   - GPU resources replaced on resize are deleted instead of leaked
 *   - shaders compile in parallel (KHR_parallel_shader_compile) and the
 *     engine starts on the frame they're ready, so creation never blocks the
 *     main thread; programs the config never uses are created lazily
 */

export type FluidQuality = 0 | 1 | 2;

export const QUALITY_TIERS: ReadonlyArray<{ sim: number; dye: number }> = [
    { sim: 200, dye: 512 },
    { sim: 128, dye: 384 },
    { sim: 96, dye: 256 },
];

export interface FluidOptions {
    /** Starting tier (0 = full). Mobile callers pass 1. */
    quality?: FluidQuality;
    /** Render a single calm frame and stop (prefers-reduced-motion). */
    staticFrame?: boolean;
    /** Upper bound for devicePixelRatio. */
    maxPixelRatio?: number;
    /** Step quality down automatically when frames average > 22 ms. */
    adaptive?: boolean;
    onQualityChange?: (tier: FluidQuality) => void;
    onContextLost?: () => void;
    /** Called on the frame the engine starts (burst fired). */
    onReady?: () => void;
    /** Async start-up failure (e.g. a shader that won't compile on this GPU). */
    onError?: (error: unknown) => void;
}

export interface FluidController {
    pause(): void;
    resume(): void;
    setQuality(tier: FluidQuality): void;
    readonly quality: FluidQuality;
    destroy(): void;
}

export class FluidUnsupportedError extends Error {}

type GL = WebGL2RenderingContext;
type RGB = { r: number; g: number; b: number };
type Format = { internalFormat: number; format: number };

interface FBO {
    texture: WebGLTexture;
    fbo: WebGLFramebuffer;
    width: number;
    height: number;
    attach(id: number): number;
}

interface DoubleFBO {
    read: FBO;
    write: FBO;
    swap(): void;
}

const SLOW_FRAME_MS = 22;
const SAMPLE_FRAMES = 60;
const WARMUP_FRAMES = 45;
const STATIC_STEPS = 30;

export function createFluid(canvas: HTMLCanvasElement, options: FluidOptions = {}): FluidController {
    const maxPixelRatio = options.maxPixelRatio ?? 1.5;
    const staticFrame = options.staticFrame ?? false;
    const adaptive = options.adaptive ?? true;
    let quality: FluidQuality = options.quality ?? 0;

    // Logical (CSS px) size — every splat / orbit coordinate lives in this space.
    let cssW = 1;
    let cssH = 1;
    let rect = canvas.getBoundingClientRect();
    syncSize();

    const config = {
        SIM_RESOLUTION: QUALITY_TIERS[quality].sim,
        DYE_RESOLUTION: QUALITY_TIERS[quality].dye,
        DENSITY_DISSIPATION: 0.958, // trails fade so idle swirls stay dynamic, not saturated
        VELOCITY_DISSIPATION: 0.96,
        PRESSURE_DISSIPATION: 0.8,
        PRESSURE_ITERATIONS: 20,
        CURL: 42,                   // extra swirl for the marbled look
        SPLAT_RADIUS: 0.22,         // fatter ink blobs
        SHADING: true,
        COLORFUL: true,
        PAUSED: false,
        BACK_COLOR: { r: 4, g: 5, b: 12 }, // deep near-black base (immersive)
        TRANSPARENT: false,
        BLOOM: false,
        BLOOM_ITERATIONS: 8,
        BLOOM_RESOLUTION: 256,
        BLOOM_INTENSITY: 0.8,
        BLOOM_THRESHOLD: 0.8,
        BLOOM_SOFT_KNEE: 0.7,
    };

    class Pointer {
        id = -1;
        x = 0;
        y = 0;
        dx = 0;
        dy = 0;
        down = false;
        moved = false;
        everMoved = false;
        color: RGB = { r: 30, g: 0, b: 300 };
    }

    const pointers: Pointer[] = [new Pointer()];
    const splatStack: number[] = [];
    const bloomFramebuffers: FBO[] = [];

    const { gl, ext } = getWebGLContext(canvas);

    if (isMobile())
        config.SHADING = false;
    if (!ext.supportLinearFiltering) {
        config.SHADING = false;
        config.BLOOM = false;
    }

    function getWebGLContext(canvas: HTMLCanvasElement) {
        const params: WebGLContextAttributes = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

        let gl = canvas.getContext('webgl2', params) as GL | null;
        const isWebGL2 = !!gl;
        if (!isWebGL2)
            gl = (canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params)) as unknown as GL | null;
        if (!gl)
            throw new FluidUnsupportedError('WebGL is not available');

        let halfFloat: OES_texture_half_float | null = null;
        let supportLinearFiltering: unknown;
        if (isWebGL2) {
            gl.getExtension('EXT_color_buffer_float');
            supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
        } else {
            halfFloat = gl.getExtension('OES_texture_half_float');
            supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
            if (!halfFloat)
                throw new FluidUnsupportedError('Half-float textures are not available');
        }

        gl.clearColor(0.0, 0.0, 0.0, 1.0);

        const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat!.HALF_FLOAT_OES;
        let formatRGBA: Format | null;
        let formatRG: Format | null;
        let formatR: Format | null;

        if (isWebGL2) {
            formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
            formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
            formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
        }
        else {
            formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        }

        if (!formatRGBA || !formatRG || !formatR)
            throw new FluidUnsupportedError('Half-float render targets are not available');

        return {
            gl,
            ext: {
                formatRGBA,
                formatRG,
                formatR,
                halfFloatTexType,
                supportLinearFiltering: !!supportLinearFiltering,
            },
        };
    }

    function getSupportedFormat(gl: GL, internalFormat: number, format: number, type: number): Format | null {
        if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
            switch (internalFormat) {
                case gl.R16F:
                    return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
                case gl.RG16F:
                    return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
                default:
                    return null;
            }
        }

        return {
            internalFormat,
            format,
        };
    }

    function supportRenderTextureFormat(gl: GL, internalFormat: number, format: number, type: number) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        return status == gl.FRAMEBUFFER_COMPLETE;
    }

    function isMobile() {
        return /Mobi|Android/i.test(navigator.userAgent);
    }

    // Lets the driver compile/link off the main thread; we poll instead of block.
    const parallelCompile = gl.getExtension('KHR_parallel_shader_compile');

    class GLProgram {
        uniforms: Record<string, WebGLUniformLocation | null> = {};
        program: WebGLProgram;
        private finalized = false;
        private vertexShader: WebGLShader;
        private fragmentShader: WebGLShader;

        constructor(vertexShader: WebGLShader, fragmentShader: WebGLShader) {
            this.vertexShader = vertexShader;
            this.fragmentShader = fragmentShader;
            this.program = gl.createProgram()!;

            gl.attachShader(this.program, vertexShader);
            gl.attachShader(this.program, fragmentShader);
            gl.linkProgram(this.program);
        }

        /** True once the driver has finished compiling + linking (never blocks). */
        get compiled(): boolean {
            return !parallelCompile || !!gl.getProgramParameter(this.program, parallelCompile.COMPLETION_STATUS_KHR);
        }

        /** Check status and read uniforms; deferred until first use. */
        finalize() {
            if (this.finalized) return;
            this.finalized = true;

            if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
                throw new Error(
                    gl.getShaderInfoLog(this.fragmentShader) ||
                    gl.getShaderInfoLog(this.vertexShader) ||
                    gl.getProgramInfoLog(this.program) ||
                    'Program link failed');

            const uniformCount: number = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < uniformCount; i++) {
                const uniformName = gl.getActiveUniform(this.program, i)!.name;
                this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName);
            }
        }

        bind() {
            this.finalize();
            gl.useProgram(this.program);
        }
    }

    // Status is checked when the program links (GLProgram.finalize), not here,
    // so compilation can proceed in parallel.
    function compileShader(type: number, source: string) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    }

    function lazyProgram(fragmentShader: () => WebGLShader) {
        let program: GLProgram | null = null;
        return () => (program ??= new GLProgram(baseVertexShader, fragmentShader()));
    }

    const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
        precision highp float;
        attribute vec2 aPosition;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform vec2 texelSize;
        void main () {
            vUv = aPosition * 0.5 + 0.5;
            vL = vUv - vec2(texelSize.x, 0.0);
            vR = vUv + vec2(texelSize.x, 0.0);
            vT = vUv + vec2(0.0, texelSize.y);
            vB = vUv - vec2(0.0, texelSize.y);
            gl_Position = vec4(aPosition, 0.0, 1.0);
        }
    `);

    const clearShader = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        uniform sampler2D uTexture;
        uniform float value;
        void main () {
            gl_FragColor = value * texture2D(uTexture, vUv);
        }
    `);

    const colorShader = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform vec4 color;
        void main () {
            gl_FragColor = color;
        }
    `);

    const backgroundShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        uniform float aspectRatio;
        #define SCALE 25.0
        void main () {
            vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
            float v = mod(uv.x + uv.y, 2.0);
            v = v * 0.1 + 0.8;
            gl_FragColor = vec4(vec3(v), 1.0);
        }
    `);

    const displayShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        void main () {
            vec3 C = texture2D(uTexture, vUv).rgb;
            float a = max(C.r, max(C.g, C.b));
            gl_FragColor = vec4(C, a);
        }
    `);

    const displayBloomShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        uniform sampler2D uBloom;
        uniform sampler2D uDithering;
        uniform vec2 ditherScale;
        void main () {
            vec3 C = texture2D(uTexture, vUv).rgb;
            vec3 bloom = texture2D(uBloom, vUv).rgb;
            vec3 noise = texture2D(uDithering, vUv * ditherScale).rgb;
            noise = noise * 2.0 - 1.0;
            bloom += noise / 800.0;
            bloom = pow(bloom.rgb, vec3(1.0 / 2.2));
            C += bloom;
            float a = max(C.r, max(C.g, C.b));
            gl_FragColor = vec4(C, a);
        }
    `);

    const displayShadingShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform sampler2D uTexture;
        uniform vec2 texelSize;
        void main () {
            vec3 L = texture2D(uTexture, vL).rgb;
            vec3 R = texture2D(uTexture, vR).rgb;
            vec3 T = texture2D(uTexture, vT).rgb;
            vec3 B = texture2D(uTexture, vB).rgb;
            vec3 C = texture2D(uTexture, vUv).rgb;
            float dx = length(R) - length(L);
            float dy = length(T) - length(B);
            vec3 n = normalize(vec3(dx, dy, length(texelSize)));
            vec3 l = vec3(0.0, 0.0, 1.0);
            float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
            C.rgb *= diffuse;
            float a = max(C.r, max(C.g, C.b));
            gl_FragColor = vec4(C, a);
        }
    `);

    const displayBloomShadingShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform sampler2D uTexture;
        uniform sampler2D uBloom;
        uniform sampler2D uDithering;
        uniform vec2 ditherScale;
        uniform vec2 texelSize;
        void main () {
            vec3 L = texture2D(uTexture, vL).rgb;
            vec3 R = texture2D(uTexture, vR).rgb;
            vec3 T = texture2D(uTexture, vT).rgb;
            vec3 B = texture2D(uTexture, vB).rgb;
            vec3 C = texture2D(uTexture, vUv).rgb;
            float dx = length(R) - length(L);
            float dy = length(T) - length(B);
            vec3 n = normalize(vec3(dx, dy, length(texelSize)));
            vec3 l = vec3(0.0, 0.0, 1.0);
            float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
            C *= diffuse;
            vec3 bloom = texture2D(uBloom, vUv).rgb;
            vec3 noise = texture2D(uDithering, vUv * ditherScale).rgb;
            noise = noise * 2.0 - 1.0;
            bloom += noise / 800.0;
            bloom = pow(bloom.rgb, vec3(1.0 / 2.2));
            C += bloom;
            float a = max(C.r, max(C.g, C.b));
            gl_FragColor = vec4(C, a);
        }
    `);

    const bloomPrefilterShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        uniform vec3 curve;
        uniform float threshold;
        void main () {
            vec3 c = texture2D(uTexture, vUv).rgb;
            float br = max(c.r, max(c.g, c.b));
            float rq = clamp(br - curve.x, 0.0, curve.y);
            rq = curve.z * rq * rq;
            c *= max(rq, br - threshold) / max(br, 0.0001);
            gl_FragColor = vec4(c, 0.0);
        }
    `);

    const bloomBlurShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform sampler2D uTexture;
        void main () {
            vec4 sum = vec4(0.0);
            sum += texture2D(uTexture, vL);
            sum += texture2D(uTexture, vR);
            sum += texture2D(uTexture, vT);
            sum += texture2D(uTexture, vB);
            sum *= 0.25;
            gl_FragColor = sum;
        }
    `);

    const bloomFinalShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform sampler2D uTexture;
        uniform float intensity;
        void main () {
            vec4 sum = vec4(0.0);
            sum += texture2D(uTexture, vL);
            sum += texture2D(uTexture, vR);
            sum += texture2D(uTexture, vT);
            sum += texture2D(uTexture, vB);
            sum *= 0.25;
            gl_FragColor = sum * intensity;
        }
    `);

    const splatShader = compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uTarget;
        uniform float aspectRatio;
        uniform vec3 color;
        uniform vec2 point;
        uniform float radius;
        void main () {
            vec2 p = vUv - point.xy;
            p.x *= aspectRatio;
            vec3 splat = exp(-dot(p, p) / radius) * color;
            vec3 base = texture2D(uTarget, vUv).xyz;
            gl_FragColor = vec4(base + splat, 1.0);
        }
    `);

    const advectionManualFilteringShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform vec2 dyeTexelSize;
        uniform float dt;
        uniform float dissipation;
        vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
            vec2 st = uv / tsize - 0.5;
            vec2 iuv = floor(st);
            vec2 fuv = fract(st);
            vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
            vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
            vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
            vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
            return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
        }
        void main () {
            vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
            gl_FragColor = dissipation * bilerp(uSource, coord, dyeTexelSize);
            gl_FragColor.a = 1.0;
        }
    `);

    const advectionShader = () => compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform float dt;
        uniform float dissipation;
        void main () {
            vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
            gl_FragColor = dissipation * texture2D(uSource, coord);
            gl_FragColor.a = 1.0;
        }
    `);

    const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uVelocity;
        void main () {
            float L = texture2D(uVelocity, vL).x;
            float R = texture2D(uVelocity, vR).x;
            float T = texture2D(uVelocity, vT).y;
            float B = texture2D(uVelocity, vB).y;
            vec2 C = texture2D(uVelocity, vUv).xy;
            if (vL.x < 0.0) { L = -C.x; }
            if (vR.x > 1.0) { R = -C.x; }
            if (vT.y > 1.0) { T = -C.y; }
            if (vB.y < 0.0) { B = -C.y; }
            float div = 0.5 * (R - L + T - B);
            gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
        }
    `);

    const curlShader = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uVelocity;
        void main () {
            float L = texture2D(uVelocity, vL).y;
            float R = texture2D(uVelocity, vR).y;
            float T = texture2D(uVelocity, vT).x;
            float B = texture2D(uVelocity, vB).x;
            float vorticity = R - L - T + B;
            gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
        }
    `);

    const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
        precision highp float;
        precision highp sampler2D;
        varying vec2 vUv;
        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform sampler2D uVelocity;
        uniform sampler2D uCurl;
        uniform float curl;
        uniform float dt;
        void main () {
            float L = texture2D(uCurl, vL).x;
            float R = texture2D(uCurl, vR).x;
            float T = texture2D(uCurl, vT).x;
            float B = texture2D(uCurl, vB).x;
            float C = texture2D(uCurl, vUv).x;
            vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
            force /= length(force) + 0.0001;
            force *= curl * C;
            force.y *= -1.0;
            vec2 vel = texture2D(uVelocity, vUv).xy;
            gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
        }
    `);

    const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;
        vec2 boundary (vec2 uv) {
            return uv;
        }
        void main () {
            float L = texture2D(uPressure, boundary(vL)).x;
            float R = texture2D(uPressure, boundary(vR)).x;
            float T = texture2D(uPressure, boundary(vT)).x;
            float B = texture2D(uPressure, boundary(vB)).x;
            float C = texture2D(uPressure, vUv).x;
            float divergence = texture2D(uDivergence, vUv).x;
            float pressure = (L + R + B + T - divergence) * 0.25;
            gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
        }
    `);

    const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        precision mediump sampler2D;
        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;
        vec2 boundary (vec2 uv) {
            return uv;
        }
        void main () {
            float L = texture2D(uPressure, boundary(vL)).x;
            float R = texture2D(uPressure, boundary(vR)).x;
            float T = texture2D(uPressure, boundary(vT)).x;
            float B = texture2D(uPressure, boundary(vB)).x;
            vec2 velocity = texture2D(uVelocity, vUv).xy;
            velocity.xy -= vec2(R - L, T - B);
            gl_FragColor = vec4(velocity, 0.0, 1.0);
        }
    `);

    const blit = (() => {
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);

        return (destination: WebGLFramebuffer | null) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
            gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        };
    })();

    let simWidth = 0;
    let simHeight = 0;
    let dyeWidth = 0;
    let dyeHeight = 0;
    let density: DoubleFBO | null = null;
    let velocity: DoubleFBO | null = null;
    let divergence: FBO | null = null;
    let curl: FBO | null = null;
    let pressure: DoubleFBO | null = null;
    let bloom: FBO | null = null;

    const ditheringTexture = createNoiseTexture(256);

    const clearProgram = new GLProgram(baseVertexShader, clearShader);
    const colorProgram = new GLProgram(baseVertexShader, colorShader);
    // Only built if the config ever asks for them (BLOOM / TRANSPARENT are off).
    const getBackgroundProgram = lazyProgram(backgroundShader);
    const getDisplayProgram = lazyProgram(displayShader);
    const getDisplayBloomProgram = lazyProgram(displayBloomShader);
    const getDisplayShadingProgram = lazyProgram(displayShadingShader);
    const getDisplayBloomShadingProgram = lazyProgram(displayBloomShadingShader);
    const getBloomPrefilterProgram = lazyProgram(bloomPrefilterShader);
    const getBloomBlurProgram = lazyProgram(bloomBlurShader);
    const getBloomFinalProgram = lazyProgram(bloomFinalShader);
    const splatProgram = new GLProgram(baseVertexShader, splatShader);
    const advectionProgram = new GLProgram(baseVertexShader, ext.supportLinearFiltering ? advectionShader() : advectionManualFilteringShader());
    const divergenceProgram = new GLProgram(baseVertexShader, divergenceShader);
    const curlProgram = new GLProgram(baseVertexShader, curlShader);
    const vorticityProgram = new GLProgram(baseVertexShader, vorticityShader);
    const pressureProgram = new GLProgram(baseVertexShader, pressureShader);
    const gradienSubtractProgram = new GLProgram(baseVertexShader, gradientSubtractShader);

    // Everything a normal frame touches; compiled eagerly (in parallel).
    const framePrograms = [
        clearProgram, colorProgram, splatProgram, advectionProgram, divergenceProgram,
        curlProgram, vorticityProgram, pressureProgram, gradienSubtractProgram,
        config.SHADING ? getDisplayShadingProgram() : getDisplayProgram(),
    ];

    function initFramebuffers() {
        const simRes = getResolution(config.SIM_RESOLUTION);
        const dyeRes = getResolution(config.DYE_RESOLUTION);

        simWidth = simRes.width;
        simHeight = simRes.height;
        dyeWidth = dyeRes.width;
        dyeHeight = dyeRes.height;

        const texType = ext.halfFloatTexType;
        const rgba = ext.formatRGBA;
        const rg = ext.formatRG;
        const r = ext.formatR;
        const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

        if (density == null)
            density = createDoubleFBO(dyeWidth, dyeHeight, rgba.internalFormat, rgba.format, texType, filtering);
        else
            density = resizeDoubleFBO(density, dyeWidth, dyeHeight, rgba.internalFormat, rgba.format, texType, filtering);

        if (velocity == null)
            velocity = createDoubleFBO(simWidth, simHeight, rg.internalFormat, rg.format, texType, filtering);
        else
            velocity = resizeDoubleFBO(velocity, simWidth, simHeight, rg.internalFormat, rg.format, texType, filtering);

        if (divergence) deleteFBO(divergence);
        if (curl) deleteFBO(curl);
        if (pressure) { deleteFBO(pressure.read); deleteFBO(pressure.write); }

        divergence = createFBO(simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST);
        curl = createFBO(simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST);
        pressure = createDoubleFBO(simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST);

        initBloomFramebuffers();
    }

    function initBloomFramebuffers() {
        const res = getResolution(config.BLOOM_RESOLUTION);

        const texType = ext.halfFloatTexType;
        const rgba = ext.formatRGBA;
        const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

        if (bloom) deleteFBO(bloom);
        bloomFramebuffers.forEach(deleteFBO);

        bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);

        bloomFramebuffers.length = 0;
        for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
            const width = res.width >> (i + 1);
            const height = res.height >> (i + 1);

            if (width < 2 || height < 2) break;

            const fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
            bloomFramebuffers.push(fbo);
        }
    }

    function createFBO(w: number, h: number, internalFormat: number, format: number, type: number, param: number): FBO {
        gl.activeTexture(gl.TEXTURE0);
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);

        return {
            texture,
            fbo,
            width: w,
            height: h,
            attach(id: number) {
                gl.activeTexture(gl.TEXTURE0 + id);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                return id;
            },
        };
    }

    function deleteFBO(target: FBO) {
        gl.deleteFramebuffer(target.fbo);
        gl.deleteTexture(target.texture);
    }

    function createDoubleFBO(w: number, h: number, internalFormat: number, format: number, type: number, param: number): DoubleFBO {
        let fbo1 = createFBO(w, h, internalFormat, format, type, param);
        let fbo2 = createFBO(w, h, internalFormat, format, type, param);

        return {
            get read() { return fbo1; },
            set read(value) { fbo1 = value; },
            get write() { return fbo2; },
            set write(value) { fbo2 = value; },
            swap() {
                const temp = fbo1;
                fbo1 = fbo2;
                fbo2 = temp;
            },
        };
    }

    function resizeFBO(target: FBO, w: number, h: number, internalFormat: number, format: number, type: number, param: number) {
        const newFBO = createFBO(w, h, internalFormat, format, type, param);
        clearProgram.bind();
        gl.uniform1i(clearProgram.uniforms.uTexture, target.attach(0));
        gl.uniform1f(clearProgram.uniforms.value, 1);
        blit(newFBO.fbo);
        return newFBO;
    }

    function resizeDoubleFBO(target: DoubleFBO, w: number, h: number, internalFormat: number, format: number, type: number, param: number) {
        const oldRead = target.read;
        const oldWrite = target.write;
        target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
        target.write = createFBO(w, h, internalFormat, format, type, param);
        deleteFBO(oldRead);
        deleteFBO(oldWrite);
        return target;
    }

    // Procedural noise for dithering (replaces the external LDR texture).
    function createNoiseTexture(size: number) {
        const data = new Uint8Array(size * size * 3);
        for (let i = 0; i < data.length; i++)
            data[i] = Math.floor(Math.random() * 256);
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
        return {
            texture,
            width: size,
            height: size,
            attach(id: number) {
                gl.activeTexture(gl.TEXTURE0 + id);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                return id;
            },
        };
    }

    let lastColorChangeTime = Date.now();
    let virtualSeeded = false;
    let orbitAngle = 0;
    let vPrevX = 0, vPrevY = 0;
    let virtualColor: RGB | null = null;
    let lastVColorTime = 0;
    let engineStart = Date.now();
    const ORBIT_RADIUS = 300;      // px — the auto-cursor circles the centre at this radius
    const ORBIT_SPEED = 0.026;     // rad/frame (~4 s per loop)
    const ORBIT_START_DELAY = 700; // ms after load before the auto-cursor begins (burst plays first)

    // --- lifecycle state ----------------------------------------------------
    let rafHandle = 0;
    let compileHandle = 0;
    let ready = false;
    let destroyed = false;
    let userPaused = false;
    let docHidden = document.hidden;
    let onScreen = true;
    let sizeDirty = false;

    // frame-time sampling for adaptive quality
    let lastFrameTime = 0;
    let warmup = 0;
    let sampleSum = 0;
    let sampleCount = 0;

    function update(now: number) {
        rafHandle = 0;
        if (destroyed) return;
        sampleFrame(now);
        resizeCanvas();
        driveVirtualPointer();
        input();
        if (!config.PAUSED)
            step(0.016);
        render(null);
        scheduleFrame();
    }

    function scheduleFrame() {
        if (!rafHandle && shouldRun())
            rafHandle = requestAnimationFrame(update);
    }

    function shouldRun() {
        return ready && !destroyed && !staticFrame && !userPaused && !docHidden && onScreen;
    }

    function syncRunning() {
        if (shouldRun()) {
            lastFrameTime = 0;
            scheduleFrame();
        } else if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = 0;
        }
    }

    function sampleFrame(now: number) {
        if (!adaptive) return;
        const delta = lastFrameTime ? now - lastFrameTime : 0;
        lastFrameTime = now;
        // Ignore the first frame after a resume and anything that looks like a stall.
        if (delta <= 0 || delta > 250) return;
        if (warmup < WARMUP_FRAMES) { warmup++; return; }
        sampleSum += delta;
        sampleCount++;
        if (sampleCount < SAMPLE_FRAMES) return;
        const average = sampleSum / sampleCount;
        sampleSum = 0;
        sampleCount = 0;
        if (average > SLOW_FRAME_MS && quality < QUALITY_TIERS.length - 1)
            setQuality((quality + 1) as FluidQuality);
    }

    // An invisible auto-cursor orbits the centre FOREVER, independent of the real
    // pointer, splatting bright ink along a gently breathing orbit. Starts a beat
    // after load so the burst plays first.
    function driveVirtualPointer() {
        if (Date.now() - engineStart < ORBIT_START_DELAY)
            return;
        const cx = cssW / 2;
        const cy = cssH / 2;
        const base = Math.min(ORBIT_RADIUS, cssW * 0.35, cssH * 0.35);
        const r = base * (0.72 + 0.28 * Math.sin(orbitAngle * 0.37));
        orbitAngle += ORBIT_SPEED;
        const x = cx + Math.cos(orbitAngle) * r;
        const y = cy + Math.sin(orbitAngle) * r;
        if (!virtualSeeded) {
            virtualSeeded = true;
            vPrevX = x;
            vPrevY = y;
            return;
        }
        if (!virtualColor || Date.now() - lastVColorTime > 120) {
            virtualColor = generateColor();
            virtualColor.r *= 3.2;
            virtualColor.g *= 3.2;
            virtualColor.b *= 3.2;
            lastVColorTime = Date.now();
        }
        const dx = (x - vPrevX) * 9.0;
        const dy = (y - vPrevY) * 9.0;
        vPrevX = x;
        vPrevY = y;
        splat(x, y, dx, dy, virtualColor);
    }

    function input() {
        if (splatStack.length > 0)
            multipleSplats(splatStack.pop()!);

        for (let i = 0; i < pointers.length; i++) {
            const p = pointers[i];
            if (p.moved) {
                splat(p.x, p.y, p.dx, p.dy, p.color);
                p.moved = false;
            }
        }

        if (!config.COLORFUL)
            return;

        if (lastColorChangeTime + 100 < Date.now()) {
            lastColorChangeTime = Date.now();
            for (let i = 0; i < pointers.length; i++) {
                const p = pointers[i];
                p.color = generateColor();
            }
        }
    }

    function step(dt: number) {
        const vel = velocity!;
        const dens = density!;
        const pres = pressure!;

        gl.disable(gl.BLEND);
        gl.viewport(0, 0, simWidth, simHeight);

        curlProgram.bind();
        gl.uniform2f(curlProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(curlProgram.uniforms.uVelocity, vel.read.attach(0));
        blit(curl!.fbo);

        vorticityProgram.bind();
        gl.uniform2f(vorticityProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(vorticityProgram.uniforms.uVelocity, vel.read.attach(0));
        gl.uniform1i(vorticityProgram.uniforms.uCurl, curl!.attach(1));
        gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
        gl.uniform1f(vorticityProgram.uniforms.dt, dt);
        blit(vel.write.fbo);
        vel.swap();

        divergenceProgram.bind();
        gl.uniform2f(divergenceProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(divergenceProgram.uniforms.uVelocity, vel.read.attach(0));
        blit(divergence!.fbo);

        clearProgram.bind();
        gl.uniform1i(clearProgram.uniforms.uTexture, pres.read.attach(0));
        gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE_DISSIPATION);
        blit(pres.write.fbo);
        pres.swap();

        pressureProgram.bind();
        gl.uniform2f(pressureProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence!.attach(0));
        for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(pressureProgram.uniforms.uPressure, pres.read.attach(1));
            blit(pres.write.fbo);
            pres.swap();
        }

        gradienSubtractProgram.bind();
        gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pres.read.attach(0));
        gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, vel.read.attach(1));
        blit(vel.write.fbo);
        vel.swap();

        advectionProgram.bind();
        gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / simWidth, 1.0 / simHeight);
        if (!ext.supportLinearFiltering)
            gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, 1.0 / simWidth, 1.0 / simHeight);
        const velocityId = vel.read.attach(0);
        gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
        gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
        gl.uniform1f(advectionProgram.uniforms.dt, dt);
        gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
        blit(vel.write.fbo);
        vel.swap();

        gl.viewport(0, 0, dyeWidth, dyeHeight);

        if (!ext.supportLinearFiltering)
            gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, 1.0 / dyeWidth, 1.0 / dyeHeight);
        gl.uniform1i(advectionProgram.uniforms.uVelocity, vel.read.attach(0));
        gl.uniform1i(advectionProgram.uniforms.uSource, dens.read.attach(1));
        gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
        blit(dens.write.fbo);
        dens.swap();
    }

    function render(target: FBO | null) {
        if (config.BLOOM)
            applyBloom(density!.read, bloom!);

        if (target == null || !config.TRANSPARENT) {
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.enable(gl.BLEND);
        }
        else {
            gl.disable(gl.BLEND);
        }

        const width = target == null ? gl.drawingBufferWidth : dyeWidth;
        const height = target == null ? gl.drawingBufferHeight : dyeHeight;
        const targetFbo = target == null ? null : target.fbo;

        gl.viewport(0, 0, width, height);

        if (!config.TRANSPARENT) {
            colorProgram.bind();
            const bc = config.BACK_COLOR;
            gl.uniform4f(colorProgram.uniforms.color, bc.r / 255, bc.g / 255, bc.b / 255, 1);
            blit(targetFbo);
        }

        if (target == null && config.TRANSPARENT) {
            const backgroundProgram = getBackgroundProgram();
            backgroundProgram.bind();
            gl.uniform1f(backgroundProgram.uniforms.aspectRatio, canvas.width / canvas.height);
            blit(null);
        }

        if (config.SHADING) {
            const program = config.BLOOM ? getDisplayBloomShadingProgram() : getDisplayShadingProgram();
            program.bind();
            gl.uniform2f(program.uniforms.texelSize, 1.0 / width, 1.0 / height);
            gl.uniform1i(program.uniforms.uTexture, density!.read.attach(0));
            if (config.BLOOM) {
                gl.uniform1i(program.uniforms.uBloom, bloom!.attach(1));
                gl.uniform1i(program.uniforms.uDithering, ditheringTexture.attach(2));
                const scale = getTextureScale(ditheringTexture, width, height);
                gl.uniform2f(program.uniforms.ditherScale, scale.x, scale.y);
            }
        }
        else {
            const program = config.BLOOM ? getDisplayBloomProgram() : getDisplayProgram();
            program.bind();
            gl.uniform1i(program.uniforms.uTexture, density!.read.attach(0));
            if (config.BLOOM) {
                gl.uniform1i(program.uniforms.uBloom, bloom!.attach(1));
                gl.uniform1i(program.uniforms.uDithering, ditheringTexture.attach(2));
                const scale = getTextureScale(ditheringTexture, width, height);
                gl.uniform2f(program.uniforms.ditherScale, scale.x, scale.y);
            }
        }

        blit(targetFbo);
    }

    function applyBloom(source: FBO, destination: FBO) {
        if (bloomFramebuffers.length < 2)
            return;

        const bloomPrefilterProgram = getBloomPrefilterProgram();
        const bloomBlurProgram = getBloomBlurProgram();
        const bloomFinalProgram = getBloomFinalProgram();
        let last = destination;

        gl.disable(gl.BLEND);
        bloomPrefilterProgram.bind();
        const knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
        const curve0 = config.BLOOM_THRESHOLD - knee;
        const curve1 = knee * 2;
        const curve2 = 0.25 / knee;
        gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
        gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
        gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
        gl.viewport(0, 0, last.width, last.height);
        blit(last.fbo);

        bloomBlurProgram.bind();
        for (let i = 0; i < bloomFramebuffers.length; i++) {
            const dest = bloomFramebuffers[i];
            gl.uniform2f(bloomBlurProgram.uniforms.texelSize, 1.0 / last.width, 1.0 / last.height);
            gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
            gl.viewport(0, 0, dest.width, dest.height);
            blit(dest.fbo);
            last = dest;
        }

        gl.blendFunc(gl.ONE, gl.ONE);
        gl.enable(gl.BLEND);

        for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
            const baseTex = bloomFramebuffers[i];
            gl.uniform2f(bloomBlurProgram.uniforms.texelSize, 1.0 / last.width, 1.0 / last.height);
            gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
            gl.viewport(0, 0, baseTex.width, baseTex.height);
            blit(baseTex.fbo);
            last = baseTex;
        }

        gl.disable(gl.BLEND);
        bloomFinalProgram.bind();
        gl.uniform2f(bloomFinalProgram.uniforms.texelSize, 1.0 / last.width, 1.0 / last.height);
        gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
        gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
        gl.viewport(0, 0, destination.width, destination.height);
        blit(destination.fbo);
    }

    function splat(x: number, y: number, dx: number, dy: number, color: RGB) {
        const vel = velocity!;
        const dens = density!;

        gl.viewport(0, 0, simWidth, simHeight);
        splatProgram.bind();
        gl.uniform1i(splatProgram.uniforms.uTarget, vel.read.attach(0));
        gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
        gl.uniform2f(splatProgram.uniforms.point, x / cssW, 1.0 - y / cssH);
        gl.uniform3f(splatProgram.uniforms.color, dx, -dy, 1.0);
        gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS / 100.0);
        blit(vel.write.fbo);
        vel.swap();

        gl.viewport(0, 0, dyeWidth, dyeHeight);
        gl.uniform1i(splatProgram.uniforms.uTarget, dens.read.attach(0));
        gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
        blit(dens.write.fbo);
        dens.swap();
    }

    function multipleSplats(amount: number) {
        for (let i = 0; i < amount; i++) {
            const color = generateColor();
            color.r *= 10.0;
            color.g *= 10.0;
            color.b *= 10.0;
            const x = cssW * Math.random();
            const y = cssH * Math.random();
            const dx = 1000 * (Math.random() - 0.5);
            const dy = 1000 * (Math.random() - 0.5);
            splat(x, y, dx, dy, color);
        }
    }

    /** Sync the backing store to the element size (DPR-capped). Returns true if it changed. */
    function syncSize() {
        const pr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
        cssW = Math.max(1, canvas.clientWidth);
        cssH = Math.max(1, canvas.clientHeight);
        const w = Math.max(1, Math.round(cssW * pr));
        const h = Math.max(1, Math.round(cssH * pr));
        if (canvas.width === w && canvas.height === h)
            return false;
        canvas.width = w;
        canvas.height = h;
        return true;
    }

    // Size is tracked by a ResizeObserver instead of reading clientWidth every
    // frame, so the engine never forces layout while GSAP writes transforms.
    function resizeCanvas() {
        if (!sizeDirty) return;
        sizeDirty = false;
        rect = canvas.getBoundingClientRect();
        if (syncSize())
            initFramebuffers();
    }

    // The canvas renders BEHIND page content, so pointer data is read from window
    // events and mapped into canvas space via its (cached) bounding rect.
    // Listeners are passive and never preventDefault, so page scroll is untouched.
    function pointerPos(clientX: number, clientY: number) {
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    const teardown: Array<() => void> = [];
    function on<K extends keyof WindowEventMap>(target: Window, type: K, handler: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void;
    function on(target: EventTarget, type: string, handler: (e: Event) => void, opts?: AddEventListenerOptions): void;
    function on(target: EventTarget, type: string, handler: (e: any) => void, opts?: AddEventListenerOptions) {
        target.addEventListener(type, handler, opts);
        teardown.push(() => target.removeEventListener(type, handler, opts));
    }

    if (!staticFrame) {
        on(window, 'mousemove', e => {
            const { x, y } = pointerPos(e.clientX, e.clientY);
            const p = pointers[0];
            if (!p.everMoved) {
                p.everMoved = true;
                p.x = x;
                p.y = y;
                p.down = true;
                return;
            }
            p.down = true;
            p.moved = true;
            p.dx = (x - p.x) * 5.0;
            p.dy = (y - p.y) * 5.0;
            p.x = x;
            p.y = y;
            p.color = generateColor();
        }, { passive: true });

        on(window, 'touchmove', e => {
            const touches = e.targetTouches;
            for (let i = 0; i < touches.length; i++) {
                if (i >= pointers.length)
                    pointers.push(new Pointer());
                const p = pointers[i];
                const { x, y } = pointerPos(touches[i].clientX, touches[i].clientY);
                p.down = true;
                p.moved = p.everMoved === true;
                p.everMoved = true;
                p.dx = (x - p.x) * 8.0;
                p.dy = (y - p.y) * 8.0;
                p.x = x;
                p.y = y;
            }
        }, { passive: true });

        on(window, 'touchstart', e => {
            const touches = e.targetTouches;
            for (let i = 0; i < touches.length; i++) {
                if (i >= pointers.length)
                    pointers.push(new Pointer());
                const p = pointers[i];
                const { x, y } = pointerPos(touches[i].clientX, touches[i].clientY);
                p.id = touches[i].identifier;
                p.down = true;
                p.x = x;
                p.y = y;
                p.color = generateColor();
            }
        }, { passive: true });

        on(window, 'mouseup', () => {
            pointers[0].down = false;
        }, { passive: true });

        on(window, 'touchend', e => {
            const touches = e.changedTouches;
            for (let i = 0; i < touches.length; i++)
                for (let j = 0; j < pointers.length; j++)
                    if (touches[i].identifier == pointers[j].id)
                        pointers[j].down = false;
        }, { passive: true });
    }

    on(document, 'visibilitychange', () => {
        docHidden = document.hidden;
        syncRunning();
    });

    on(canvas, 'webglcontextlost', e => {
        e.preventDefault();
        destroy();
        options.onContextLost?.();
    });

    const resizeObserver = new ResizeObserver(() => {
        sizeDirty = true;
        if (staticFrame && ready) {
            resizeCanvas();
            render(null);
        }
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(entries => {
        onScreen = entries[entries.length - 1].isIntersecting;
        syncRunning();
    });
    intersectionObserver.observe(canvas);

    // Wait (without blocking) for the driver to finish the frame programs,
    // then start on that frame.
    function whenCompiled() {
        compileHandle = 0;
        if (destroyed) return;
        if (!framePrograms.every((program) => program.compiled)) {
            compileHandle = requestAnimationFrame(whenCompiled);
            return;
        }
        try {
            start();
        } catch (error) {
            destroy();
            options.onError?.(error);
        }
    }
    compileHandle = requestAnimationFrame(whenCompiled);

    function start() {
        framePrograms.forEach((program) => program.finalize());
        initFramebuffers();
        // Strong entrance: a dense burst plus several rapid follow-up waves
        // (drained one-per-frame by input() via splatStack).
        multipleSplats(34);
        for (let i = 0; i < 8; i++)
            splatStack.push(10 + Math.floor(Math.random() * 10));
        lastColorChangeTime = Date.now();
        engineStart = Date.now();
        ready = true;
        options.onReady?.();

        if (staticFrame) {
            // A calm, still frame: let the burst settle for a moment, then stop.
            for (let i = 0; i < STATIC_STEPS; i++) {
                input();
                step(0.016);
            }
            render(null);
        } else {
            scheduleFrame();
        }
    }

    function setQuality(tier: FluidQuality) {
        if (destroyed || tier === quality) return;
        quality = tier;
        config.SIM_RESOLUTION = QUALITY_TIERS[tier].sim;
        config.DYE_RESOLUTION = QUALITY_TIERS[tier].dye;
        if (!ready) return; // start() allocates at the new size
        initFramebuffers();
        warmup = 0;
        sampleSum = 0;
        sampleCount = 0;
        if (staticFrame) render(null);
        options.onQualityChange?.(tier);
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (rafHandle) cancelAnimationFrame(rafHandle);
        if (compileHandle) cancelAnimationFrame(compileHandle);
        rafHandle = 0;
        compileHandle = 0;
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        for (const off of teardown) off();
    }

    return {
        pause() { userPaused = true; syncRunning(); },
        resume() { userPaused = false; syncRunning(); },
        setQuality,
        get quality() { return quality; },
        destroy,
    };

    function generateColor(): RGB {
        // Electric cyan→blue→violet→magenta band, full brightness, for a vivid,
        // slick, immersive palette.
        const h = 0.5 + Math.random() * 0.42;
        const c = HSVtoRGB(h, 0.95, 1.0);
        c.r *= 0.92;
        c.g *= 0.92;
        c.b *= 0.92;
        return c;
    }

    function HSVtoRGB(h: number, s: number, v: number): RGB {
        let r = 0, g = 0, b = 0;
        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);

        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            case 5: r = v; g = p; b = q; break;
        }
        return { r, g, b };
    }

    function getResolution(resolution: number) {
        let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
        if (aspectRatio < 1)
            aspectRatio = 1.0 / aspectRatio;

        const max = Math.round(resolution * aspectRatio);
        const min = Math.round(resolution);

        if (gl.drawingBufferWidth > gl.drawingBufferHeight)
            return { width: max, height: min };
        else
            return { width: min, height: max };
    }

    function getTextureScale(texture: { width: number; height: number }, width: number, height: number) {
        return { x: width / texture.width, y: height / texture.height };
    }
}
