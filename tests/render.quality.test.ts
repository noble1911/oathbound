// The first graphics-tier guess (src/render/core/quality.ts): weak and integrated machines must start on low,
// because the frame probe only ever lowers the tier and needs a battle's worth of slow frames to do it.
import { describe, expect, it } from 'vitest';
import { guessTierFrom } from '../src/render/core/quality.ts';

const desk = { mobile: false, cores: 16, memoryGb: 8 };

describe('guessTierFrom', () => {
  it('puts integrated, software and entry-level GPUs on low', () => {
    for (const g of [
      'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 960M Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce GT 1030 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ]) expect(guessTierFrom(g, desk), g).toBe('low');
  });

  it('puts an unknown or hidden GPU on a small machine on low', () => {
    expect(guessTierFrom('WebKit WebGL', { mobile: false, cores: 4, memoryGb: 8 })).toBe('low');
    expect(guessTierFrom('ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11)', { mobile: false, cores: 8, memoryGb: 4 })).toBe('low');
    expect(guessTierFrom('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)', { mobile: false, cores: 2 })).toBe('low');
    expect(guessTierFrom('WebKit WebGL', { mobile: false })).toBe('medium');
  });

  it('keeps strong discrete GPUs on high, but not on a 4-thread machine', () => {
    expect(guessTierFrom('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', desk)).toBe('high');
    expect(guessTierFrom('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', { mobile: false, cores: 4, memoryGb: 8 })).toBe('medium');
    expect(guessTierFrom('ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11)', desk)).toBe('medium');
  });

  it('phones get low unless the GPU is a recent flagship', () => {
    expect(guessTierFrom('Mali-G57', { mobile: true, cores: 8, memoryGb: 4 })).toBe('low');
    expect(guessTierFrom('Apple GPU', { mobile: true })).toBe('medium');
  });
});
