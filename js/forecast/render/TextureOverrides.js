// Port of Sources/Forecast/Render/TextureOverrides.swift — web build: no AI-upscaled overrides. Only the
// logical-size helpers remain (a GXTexture carries logicalWidth/logicalHeight itself).
export const TextureOverrides = {
    enabled: false,
    /** The size the original texture had — use this (never the GL size) for geometry and UV math. */
    logicalSize(t) { return [t.logicalWidth ?? t.width, t.logicalHeight ?? t.height]; },
};
