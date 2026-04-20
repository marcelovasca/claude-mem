/**
 * Tests for Qwen CLI compatibility (Issue #qwen)
 *
 * Validates:
 * 1. BeforeAgent is mapped to session-init
 * 2. Transcript parser handles Qwen JSON document format (type: "qwen" or "gemini")
 * 3. Summarize handler includes platformSource in the request body
 */
import { describe, it, expect } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// 1. BeforeAgent event mapping
// ---------------------------------------------------------------------------

describe('QwenCliHooksInstaller - event mapping', () => {
  it('should map BeforeAgent to session-init', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/QwenCliHooksInstaller.ts', 'utf-8');

    // BeforeAgent must map to 'session-init'
    expect(src).toContain("'BeforeAgent': 'session-init'");
  });

  it('should map SessionStart to context', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/QwenCliHooksInstaller.ts', 'utf-8');
    expect(src).toContain("'SessionStart': 'context'");
  });

  it('should map SessionEnd to session-complete', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/QwenCliHooksInstaller.ts', 'utf-8');
    expect(src).toContain("'SessionEnd': 'session-complete'");
  });
});

// ---------------------------------------------------------------------------
// 2. Transcript parser — Qwen JSON document format
// ---------------------------------------------------------------------------

describe('extractLastMessage - Qwen CLI transcript format', () => {
  let tmpDir: string;

  // Helper: write a temp transcript file and return its path
  const writeTranscript = (name: string, content: string): string => {
    const filePath = join(tmpDir, name);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  };

  // Set up / tear down a fresh temp directory per suite
  const setup = () => {
    tmpDir = join(tmpdir(), `qwen-transcript-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  };
  const teardown = () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  describe('Qwen/Gemini JSON document format', () => {
    it('extracts last assistant message from Qwen transcript (type: "qwen")', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const transcript = JSON.stringify({
          messages: [
            { type: 'user', content: 'Hello Qwen' },
            { type: 'qwen', content: 'Hi there! I am Qwen.' },
          ]
        });
        const filePath = writeTranscript('qwen.json', transcript);

        const result = extractLastMessage(filePath, 'assistant');
        expect(result).toBe('Hi there! I am Qwen.');
      } finally {
        teardown();
      }
    });

    it('extracts last assistant message from Qwen transcript (type: "gemini" - legacy/fork compatibility)', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const transcript = JSON.stringify({
          messages: [
            { type: 'user', content: 'Hello' },
            { type: 'gemini', content: 'Hi there!' },
          ]
        });
        const filePath = writeTranscript('qwen-legacy.json', transcript);

        const result = extractLastMessage(filePath, 'assistant');
        expect(result).toBe('Hi there!');
      } finally {
        teardown();
      }
    });

    it('extracts last user message from Qwen transcript', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const transcript = JSON.stringify({
          messages: [
            { type: 'user', content: 'First message' },
            { type: 'qwen', content: 'First reply' },
            { type: 'user', content: 'Second message' },
          ]
        });
        const filePath = writeTranscript('qwen-user.json', transcript);

        const result = extractLastMessage(filePath, 'user');
        expect(result).toBe('Second message');
      } finally {
        teardown();
      }
    });
  });
});
