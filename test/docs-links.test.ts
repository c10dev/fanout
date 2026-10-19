import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error plain JavaScript script, no types
import { anchors, problems } from '../scripts/check-links.mjs';

describe('docs links', () => {
  it('every relative link and #anchor in the Markdown docs resolves', () => {
    assert.deepEqual(problems(), []);
  });

  it('makes anchors the way GitHub does', () => {
    const a = anchors('# 첫 댓글\n## Remaining limits (`fanout limits`)\n```\n# not a heading\n```\n# 첫 댓글\n') as Set<string>;
    assert.deepEqual([...a], ['첫-댓글', 'remaining-limits-fanout-limits', '첫-댓글-1']);
  });
});
