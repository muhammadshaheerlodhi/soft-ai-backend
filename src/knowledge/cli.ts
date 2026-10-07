/**
 * Release pipeline command: index the ERP's help content into the knowledge base.
 *
 *   npm run knowledge:index -- --erp <path to the ERP code> --version <release id>
 *
 * --version should be unique per ERP release (for example the git commit id).
 * Running it again with an already-active version does nothing.
 * Run it after every ERP deployment (later: automatically from the deploy pipeline).
 */
import { loadConfig } from "../config.js";
import { createSql } from "../db/client.js";
import { FakeEmbedder, GeminiEmbedder, type Embedder } from "../ai/embedder.js";
import { extractErpKnowledge } from "./extract-erp.js";
import { indexRelease } from "./indexer.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const erp = arg("erp");
  const version = arg("version");
  if (!erp || !version) {
    console.error("Usage: npm run knowledge:index -- --erp <path to ERP code> --version <release id>");
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  const embedder: Embedder =
    config.aiProvider === "gemini" ? new GeminiEmbedder({ apiKey: config.geminiApiKey!, model: config.embeddingModel }) : new FakeEmbedder();
  const sql = createSql(config.databaseUrl, { max: 2 });

  try {
    const { docs, pages } = await extractErpKnowledge(erp);
    console.log(`extracted ${docs.length} documents and ${pages.length} menu pages from ${erp}`);
    const stats = await indexRelease({ sql, embedder, docs, version, notes: `indexed from ERP code (${embedder.id})`, log: (m) => console.log(m) });
    console.log(`done: ${JSON.stringify(stats)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`knowledge indexing FAILED (the previous knowledge stays active): ${(err as Error).message}`);
  // exitCode instead of process.exit(): lets connections close cleanly (avoids a Windows/Node crash on exit)
  process.exitCode = 1;
});
