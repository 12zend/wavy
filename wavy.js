(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('wavy must run unsandboxed');
  }

  const renderer = Scratch.vm && Scratch.vm.renderer;
  const Cast = Scratch.Cast;

  // Changing regions flushes any pen lines queued by TurboWarp before we read
  // the pen framebuffer. The next renderer operation restores its own state.
  const wavyDrawRegion = {
    enter: () => {},
    exit: () => {}
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const hashString = value => {
    const text = String(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };

  const mulberry32 = seed => {
    let state = seed >>> 0;
    return () => {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  };

  class PerlinNoise {
    constructor (seed) {
      const random = mulberry32(hashString(seed));
      const values = new Uint8Array(256);
      for (let i = 0; i < 256; i++) values[i] = i;
      for (let i = 255; i > 0; i--) {
        const other = Math.floor(random() * (i + 1));
        const temporary = values[i];
        values[i] = values[other];
        values[other] = temporary;
      }

      this.permutation = new Uint8Array(512);
      for (let i = 0; i < 512; i++) {
        this.permutation[i] = values[i & 255];
      }
    }

    fade (value) {
      return value * value * value * (value * (value * 6 - 15) + 10);
    }

    gradient (hash, x, y) {
      switch (hash & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
      }
    }

    sample (x, y) {
      const floorX = Math.floor(x);
      const floorY = Math.floor(y);
      const cellX = floorX & 255;
      const cellY = floorY & 255;
      const localX = x - floorX;
      const localY = y - floorY;
      const u = this.fade(localX);
      const v = this.fade(localY);
      const p = this.permutation;

      const aa = p[p[cellX] + cellY];
      const ab = p[p[cellX] + cellY + 1];
      const ba = p[p[cellX + 1] + cellY];
      const bb = p[p[cellX + 1] + cellY + 1];

      const topLeft = this.gradient(aa, localX, localY);
      const topRight = this.gradient(ba, localX - 1, localY);
      const bottomLeft = this.gradient(ab, localX, localY - 1);
      const bottomRight = this.gradient(bb, localX - 1, localY - 1);
      const top = topLeft + u * (topRight - topLeft);
      const bottom = bottomLeft + u * (bottomRight - bottomLeft);

      // The theoretical gradient range is wider than [-1, 1], so keep the
      // displacement bounded when gradients align at rare points.
      return clamp((top + v * (bottom - top)) * 0.70710678118, -1, 1);
    }
  }

  const bilinearPixel = (source, width, height, x, y, output, outputIndex) => {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
      output[outputIndex] = 0;
      output[outputIndex + 1] = 0;
      output[outputIndex + 2] = 0;
      output[outputIndex + 3] = 0;
      return;
    }

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const fractionX = x - x0;
    const fractionY = y - y0;
    const topWeight = 1 - fractionY;
    const bottomWeight = fractionY;
    const weight00 = (1 - fractionX) * topWeight;
    const weight10 = fractionX * topWeight;
    const weight01 = (1 - fractionX) * bottomWeight;
    const weight11 = fractionX * bottomWeight;
    const index00 = (y0 * width + x0) * 4;
    const index10 = (y0 * width + x1) * 4;
    const index01 = (y1 * width + x0) * 4;
    const index11 = (y1 * width + x1) * 4;

    for (let channel = 0; channel < 4; channel++) {
      output[outputIndex + channel] =
        source[index00 + channel] * weight00 +
        source[index10 + channel] * weight10 +
        source[index01 + channel] * weight01 +
        source[index11 + channel] * weight11;
    }
  };

  class Wavy {
    constructor () {
      this.scale = 50;
      this.strength = 12;
      this.offsetX = 0;
      this.offsetY = 0;
      this.seed = '0';
      this.noiseX = new PerlinNoise(this.seed);
      this.noiseY = new PerlinNoise(`${this.seed}\u0000y`);
    }

    getInfo () {
      return {
        id: 'wavy',
        name: 'wavy',
        color1: '#6574E6',
        color2: '#5362CF',
        color3: '#424FB0',
        blocks: [
          {
            opcode: 'setNoise',
            blockType: Scratch.BlockType.COMMAND,
            text: 'set noise scale [SCALE] strength [STRENGTH] offset x [OFFSET_X] y [OFFSET_Y] seed [SEED]',
            arguments: {
              SCALE: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 50
              },
              STRENGTH: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 12
              },
              OFFSET_X: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 0
              },
              OFFSET_Y: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 0
              },
              SEED: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: '0'
              }
            }
          },
          {
            opcode: 'wavy',
            blockType: Scratch.BlockType.COMMAND,
            text: 'wavy'
          }
        ]
      };
    }

    setNoise (args) {
      const scale = Math.abs(Cast.toNumber(args.SCALE));
      const strength = Cast.toNumber(args.STRENGTH);
      const offsetX = Cast.toNumber(args.OFFSET_X);
      const offsetY = Cast.toNumber(args.OFFSET_Y);
      this.scale = Number.isFinite(scale) ? Math.max(0.0001, scale) : 0.0001;
      this.strength = Number.isFinite(strength) ? strength : 0;
      this.offsetX = Number.isFinite(offsetX) ? offsetX : 0;
      this.offsetY = Number.isFinite(offsetY) ? offsetY : 0;
      this.seed = Cast.toString(args.SEED);
      this.noiseX = new PerlinNoise(this.seed);
      this.noiseY = new PerlinNoise(`${this.seed}\u0000y`);
    }

    getPenSkin () {
      if (!renderer || renderer._penSkinId === null ||
          renderer._penSkinId === undefined || !renderer._allSkins) {
        return null;
      }
      return renderer._allSkins[renderer._penSkinId] || null;
    }

    wavy () {
      try {
        this.applyWavy();
      } catch (error) {
        // Unsandboxed extension blocks must not let errors escape into the VM.
        console.error('wavy could not process the pen layer:', error);
      }
    }

    applyWavy () {
      const penSkin = this.getPenSkin();
      if (!penSkin || !penSkin._framebuffer || !penSkin._texture ||
          !penSkin._size || !renderer.gl) {
        return;
      }

      const gl = renderer.gl;
      const width = Math.floor(penSkin._size[0]);
      const height = Math.floor(penSkin._size[1]);
      if (width < 1 || height < 1) return;

      // This exits the pen-line draw region and flushes batched pen geometry.
      renderer.enterDrawRegion(wavyDrawRegion);

      const framebuffer = penSkin._framebuffer.framebuffer || penSkin._framebuffer;
      const source = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const output = new Uint8Array(source.length);
      const quality = Number.isFinite(penSkin.renderQuality) && penSkin.renderQuality > 0
        ? penSkin.renderQuality
        : 1;
      const inverseScale = 1 / (this.scale * quality);
      const strength = this.strength * quality;
      const offsetX = this.offsetX * quality;
      const offsetY = this.offsetY * quality;

      let outputIndex = 0;
      for (let y = 0; y < height; y++) {
        const noiseY = (y + offsetY) * inverseScale;
        for (let x = 0; x < width; x++) {
          const noiseX = (x + offsetX) * inverseScale;
          const displacementX = this.noiseX.sample(noiseX, noiseY) * strength;
          const displacementY = this.noiseY.sample(noiseX, noiseY) * strength;
          bilinearPixel(
            source,
            width,
            height,
            x - displacementX,
            y - displacementY,
            output,
            outputIndex
          );
          outputIndex += 4;
        }
      }

      gl.bindTexture(gl.TEXTURE_2D, penSkin._texture);
      const previousUnpackAlignment = typeof gl.getParameter === 'function'
        ? gl.getParameter(gl.UNPACK_ALIGNMENT)
        : 4;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        output
      );
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousUnpackAlignment);
      gl.bindTexture(gl.TEXTURE_2D, null);

      penSkin._silhouetteDirty = true;
      if (typeof penSkin.emitWasAltered === 'function') {
        penSkin.emitWasAltered();
      }
      renderer.dirty = true;
      if (Scratch.vm.runtime && typeof Scratch.vm.runtime.requestRedraw === 'function') {
        Scratch.vm.runtime.requestRedraw();
      }
    }
  }

  Scratch.extensions.register(new Wavy());
})(Scratch);
