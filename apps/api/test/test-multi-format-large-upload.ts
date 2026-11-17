import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractText } from "../src/services/files.js";

async function main() {
  console.log("Testing universal file extraction and large file handling...");

  // 1. Test Large Text file (5MB+)
  const largeFilePath = join(tmpdir(), "large_textbook_chapter.txt");
  const repeatParagraph = "Chapter 1: Advanced Algorithms and Data Structures.\nThis textbook section discusses amortized complexity, self-balancing binary search trees, and persistent data structures in modern computational biology.\n\n";
  const largeContent = repeatParagraph.repeat(35000); // ~5.5 MB
  writeFileSync(largeFilePath, largeContent, "utf8");

  try {
    console.log(`Extracting 5.5MB text file (${(largeContent.length / 1024 / 1024).toFixed(2)} MB)...`);
    const largeRes = await extractText(largeFilePath, "text/plain", "large_textbook_chapter.txt");
    console.log(`  Result ok: ${largeRes.ok}`);
    console.log(`  Pages generated: ${largeRes.pages.length}`);
    console.log(`  Characters extracted: ${largeRes.chars}`);
  } finally {
    try { unlinkSync(largeFilePath); } catch {}
  }

  // 2. Test Code file (.py)
  const codePath = join(tmpdir(), "test_neural_net.py");
  const codeContent = `
import torch
import torch.nn as nn

class TransformerModel(nn.Module):
    def __init__(self, d_model=512, nhead=8):
        super().__init__()
        self.encoder = nn.TransformerEncoderLayer(d_model=d_model, nhead=nhead)
        
    def forward(self, x):
        return self.encoder(x)
`;
  writeFileSync(codePath, codeContent, "utf8");

  try {
    console.log("\nExtracting Python script (.py)...");
    const pyRes = await extractText(codePath, "text/x-python", "test_neural_net.py");
    console.log(`  Result ok: ${pyRes.ok}`);
    console.log(`  Chars extracted: ${pyRes.chars}`);
    console.log(`  Snippet: "${pyRes.text.slice(0, 60).replace(/\s+/g, " ")}..."`);
  } finally {
    try { unlinkSync(codePath); } catch {}
  }

  // 3. Test Markdown file (.md)
  const mdPath = join(tmpdir(), "study_notes.md");
  const mdContent = "# Academic Study Notes\n\n- Key Theorem: Central Limit Theorem\n- Formula: $Z = \\frac{\\bar{X} - \\mu}{\\sigma / \\sqrt{n}}$\n";
  writeFileSync(mdPath, mdContent, "utf8");

  try {
    console.log("\nExtracting Markdown notes (.md)...");
    const mdRes = await extractText(mdPath, "text/markdown", "study_notes.md");
    console.log(`  Result ok: ${mdRes.ok}`);
    console.log(`  Chars extracted: ${mdRes.chars}`);
  } finally {
    try { unlinkSync(mdPath); } catch {}
  }

  // 4. Test Scanned / Binary fallback
  const binPath = join(tmpdir(), "sample_binary.dat");
  const binBuffer = Buffer.alloc(1024 * 50, 0x01); // 50 KB binary
  writeFileSync(binPath, binBuffer);

  try {
    console.log("\nExtracting Binary/Raw file (.dat)...");
    const binRes = await extractText(binPath, "application/octet-stream", "sample_binary.dat");
    console.log(`  Result ok: ${binRes.ok}`);
    console.log(`  Text: "${binRes.text}"`);
  } finally {
    try { unlinkSync(binPath); } catch {}
  }

  console.log("\n✅ All universal extraction tests passed!");
}

main().catch(console.error);
