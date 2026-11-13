import type { StudyMemory } from "@recallai/shared-types";
import { config } from "../config.js";
import { falkorContext, type GraphContextRetrieval } from "./falkordb.js";

/**
 * Clean, isolated interface for Graph Memory operations.
 * Allows FalkorDB to remain completely disconnected without breaking the agent.
 */
export interface GraphMemoryProvider {
  readonly name: string;
  readonly isConnected: boolean;

  init(): Promise<void>;
  close(): Promise<void>;
  retrieveMemories(query: string, limit?: number, userId?: string): Promise<GraphContextRetrieval>;
  storeMemory(memory: StudyMemory, relatedConceptName?: string, userId?: string): Promise<boolean>;
  updateMemory(id: string, updates: Partial<StudyMemory>): Promise<boolean>;
  deleteMemory(id: string): Promise<boolean>;
  healthCheck(): Promise<{
    ok: boolean;
    connected: boolean;
    provider: string;
    status: string;
    graph?: string | null;
  }>;
}

/**
 * DisabledGraphMemoryProvider
 *
 * Active while FalkorDB is not connected. Gracefully skips all graph operations
 * without errors or timeouts, allowing the application and RAG pipeline to operate
 * completely independently.
 */
export class DisabledGraphMemoryProvider implements GraphMemoryProvider {
  readonly name = "disabled";
  readonly isConnected = false;

  async init(): Promise<void> {
    // No-op while disconnected
  }

  async close(): Promise<void> {
    // No-op
  }

  async retrieveMemories(): Promise<GraphContextRetrieval> {
    return { items: [], source: "fallback" };
  }

  async storeMemory(): Promise<boolean> {
    return false;
  }

  async updateMemory(): Promise<boolean> {
    return false;
  }

  async deleteMemory(): Promise<boolean> {
    return false;
  }

  async healthCheck(): Promise<{
    ok: boolean;
    connected: boolean;
    provider: string;
    status: string;
    graph?: string | null;
  }> {
    return {
      ok: true,
      connected: false,
      provider: "disabled",
      status: "disconnected (waiting for FALKORDB_URL)",
      graph: null,
    };
  }
}

/**
 * FalkorDBGraphMemoryProvider
 *
 * Wraps the existing FalkorDB context service. Only connects when FALKORDB_URL or
 * FALKORDB_HOST is explicitly provided by the user.
 */
export class FalkorDBGraphMemoryProvider implements GraphMemoryProvider {
  readonly name = "falkordb";

  get isConnected(): boolean {
    return falkorContext.isConnected;
  }

  async init(): Promise<void> {
    if (config.hasFalkorDB) {
      await falkorContext.init();
    }
  }

  async close(): Promise<void> {
    await falkorContext.close();
  }

  async retrieveMemories(query: string, limit = 4, userId?: string): Promise<GraphContextRetrieval> {
    if (!this.isConnected) {
      return { items: [], source: "fallback" };
    }
    return falkorContext.retrieveContext(query, limit, userId);
  }

  async storeMemory(memory: StudyMemory, relatedConceptName?: string, userId?: string): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      await falkorContext.upsertMemory(memory as any, { userId });
      return true;
    } catch {
      return false;
    }
  }

  async updateMemory(id: string, updates: Partial<StudyMemory>): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      await falkorContext.upsertMemory({ id, ...updates } as any);
      return true;
    } catch {
      return false;
    }
  }

  async deleteMemory(id: string): Promise<boolean> {
    if (!this.isConnected) return false;
    return falkorContext.deleteMemory(id);
  }

  async healthCheck(): Promise<{
    ok: boolean;
    connected: boolean;
    provider: string;
    status: string;
    graph?: string | null;
  }> {
    return {
      ok: this.isConnected,
      connected: this.isConnected,
      provider: "falkordb",
      status: this.isConnected ? "connected" : "disconnected (waiting for FALKORDB_URL)",
      graph: this.isConnected ? falkorContext.graphName : null,
    };
  }
}

/**
 * Creates the active GraphMemoryProvider.
 * If FalkorDB is not configured, returns DisabledGraphMemoryProvider.
 */
export function createGraphMemoryProvider(): GraphMemoryProvider {
  if (config.hasFalkorDB) {
    return new FalkorDBGraphMemoryProvider();
  }
  return new DisabledGraphMemoryProvider();
}

export const activeGraphMemory = createGraphMemoryProvider();
