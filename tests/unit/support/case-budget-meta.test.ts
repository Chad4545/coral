import { describe, expect, it } from 'vitest';

describe('case budget meta', () => {
  it('should carry a case-declared budget', (ctx) => {
    expect(ctx.task.meta.timeout).toBe(30_000);
  }, 30_000);

  it('should carry the config budget for a case that declares none', (ctx) => {
    expect(ctx.task.meta.timeout).toBe(15_000);
  });
});
