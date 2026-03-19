import { describe, it, expect } from 'vitest';
import { stripInternalTags, formatOutbound } from './router.js';

describe('router', () => {
  describe('stripInternalTags', () => {
    it('should remove internal tags', () => {
      const input = 'Hello <internal>secret</internal> World';
      expect(stripInternalTags(input)).toBe('Hello  World');
    });

    it('should remove multiple internal tags', () => {
      const input = '<internal>one</internal> middle <internal>two</internal>';
      expect(stripInternalTags(input)).toBe('middle');
    });

    it('should remove multiline internal tags', () => {
      const input = 'Start <internal>\nsome\ninternal\nstuff\n</internal> End';
      expect(stripInternalTags(input)).toBe('Start  End');
    });

    it('should handle text with no internal tags', () => {
      const input = 'Just plain text';
      expect(stripInternalTags(input)).toBe('Just plain text');
    });

    it('should trim the result', () => {
      const input = '  <internal>secret</internal> Hello   ';
      expect(stripInternalTags(input)).toBe('Hello');
    });

    it('should return empty string for empty input', () => {
      expect(stripInternalTags('')).toBe('');
    });

    it('should return empty string if only internal tags are present', () => {
      expect(stripInternalTags('<internal>only this</internal>')).toBe('');
    });

    it('should not remove unfinished internal tags', () => {
      const input = 'Hello <internal>unclosed';
      expect(stripInternalTags(input)).toBe('Hello <internal>unclosed');
    });
  });

  describe('formatOutbound', () => {
    it('should strip internal tags and return text', () => {
      const input = 'Public <internal>private</internal>';
      expect(formatOutbound(input)).toBe('Public');
    });

    it('should return empty string if result is empty after stripping', () => {
      const input = '<internal>private</internal>';
      expect(formatOutbound(input)).toBe('');
    });

    it('should handle empty input', () => {
      expect(formatOutbound('')).toBe('');
    });
  });
});
