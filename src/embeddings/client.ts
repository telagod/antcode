// src/embeddings/client.ts
// Generic OpenAI-compatible embedding client with local fallback.

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

export interface EmbeddingRecord {
  text_hash: string;
  text_preview: string;
  embedding: number[];
  timestamp: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function hashText(text: string): string {
  // simple fnv-1a 32bit
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

// ── Local fallback: character bigram Jaccard ──
function bigrams(text: string): Set<string> {
  const s = new Set<string>();
  const t = text.toLowerCase();
  for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
  return s;
}

function jaccardSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter + 1e-9);
}

export class LocalFallbackClient implements EmbeddingClient {
  private cache = new Map<string, number[]>();

  async embed(text: string): Promise<number[]> {
    const h = hashText(text);
    const cached = this.cache.get(h);
    if (cached) return cached;

    // deterministic "embedding": 16-dim histogram of character code bins
    const vec = new Array(16).fill(0);
    const t = text.toLowerCase();
    for (let i = 0; i < t.length; i++) {
      const bin = Math.floor(t.charCodeAt(i) / 16) % 16;
      vec[bin]++;
    }
    // normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    const normalized = vec.map((v) => v / (norm + 1e-9));
    this.cache.set(h, normalized);
    return normalized;
  }

  similarity(a: string, b: string): number {
    // Prefer bigram Jaccard for string-level similarity; embedding for vector-level
    const ja = jaccardSimilarity(a, b);
    if (ja > 0.7) return ja; // fast path for very similar strings

    const va = this.embedSync(a);
    const vb = this.embedSync(b);
    const cos = cosineSimilarity(va, vb);
    return (ja + cos) / 2;
  }

  private embedSync(text: string): number[] {
    const h = hashText(text);
    let cached = this.cache.get(h);
    if (cached) return cached;
    // Can't be truly async here; just compute inline
    const vec = new Array(16).fill(0);
    const t = text.toLowerCase();
    for (let i = 0; i < t.length; i++) {
      const bin = Math.floor(t.charCodeAt(i) / 16) % 16;
      vec[bin]++;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    cached = vec.map((v) => v / (norm + 1e-9));
    this.cache.set(h, cached);
    return cached;
  }
}

export class FoxNIOEmbeddingClient implements EmbeddingClient {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private cache = new Map<string, number[]>();

  constructor(
    apiKey = process.env.ANTCODE_LLM_API_KEY ?? "",
    baseURL = process.env.ANTCODE_LLM_API_BASE ?? "https://api.moonshot.cn/v1",
    model = "text-embedding",
  ) {
    this.apiKey = apiKey;
    this.baseURL = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) throw new Error("FoxNIOEmbeddingClient: ANTCODE_LLM_API_KEY not set");
    const h = hashText(text);
    const cached = this.cache.get(h);
    if (cached) return cached;

    const res = await fetch(`${this.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
    const json = await res.json() as { data: { embedding: number[] }[] };
    const embedding = json.data[0]?.embedding ?? [];
    this.cache.set(h, embedding);
    return embedding;
  }
}

export function createEmbeddingClient(useRemote = !!process.env.ANTCODE_LLM_API_KEY): EmbeddingClient {
  if (useRemote) return new FoxNIOEmbeddingClient();
  return new LocalFallbackClient();
}

export { cosineSimilarity, hashText };
