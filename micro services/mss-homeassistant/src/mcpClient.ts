export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

export interface McpResponse {
  type: "json" | "sse";
  response?: JsonRpcResponse;
  messages?: JsonRpcResponse[];
  raw?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpClientOptions {
  endpoint: string;
  authToken?: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
}

export class HomeAssistantMcpClient {
  private endpoint: string;
  private authToken?: string;
  private sessionId?: string;
  private clientName: string;
  private clientVersion: string;
  private protocolVersion: string;

  constructor(options: McpClientOptions) {
    this.endpoint = options.endpoint;
    this.authToken = options.authToken;
    this.clientName = options.clientName ?? "micro-service-home-assistant";
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.protocolVersion = options.protocolVersion ?? "2025-06-18";
  }

  async initialize(): Promise<McpResponse> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion,
        },
        capabilities: {},
      },
    };

    return this.send(request);
  }

  async listTools(): Promise<McpResponse> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "tools-list",
      method: "tools/list",
      params: {},
    };

    return this.send(request);
  }

  async callTool(name: string, args?: unknown): Promise<McpResponse> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `tools-call-${Date.now()}`,
      method: "tools/call",
      params: {
        name,
        arguments: args ?? {},
      },
    };

    return this.send(request);
  }

  async send(message: JsonRpcRequest): Promise<McpResponse> {
    const suppressLog = message.method === "tools/list";
    if (!suppressLog) {
      console.log("MCP ->", JSON.stringify(message));
    }
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };

    if (this.authToken && this.authToken.trim() !== "") {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    if (this.sessionId && this.sessionId.trim() !== "") {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });

    if (!suppressLog) {
      console.log("MCP <- status", response.status);
    }
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) {
      this.sessionId = sessionId;
      if (!suppressLog) {
        console.log("MCP session set", sessionId);
      }
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      const raw = await response.text();
      const messages = parseSseMessages(raw);
      if (!suppressLog) {
        console.log("MCP SSE <-", raw);
      }
      return { type: "sse", messages, raw };
    }

    if (contentType.includes("application/json")) {
      const data = (await response.json()) as JsonRpcResponse;
      if (!suppressLog) {
        console.log("MCP JSON <-", JSON.stringify(data));
      }
      return { type: "json", response: data };
    }

    const raw = await response.text();
    if (!suppressLog) {
      console.log("MCP RAW <-", raw);
    }
    return { type: "sse", messages: [], raw };
  }
}

function parseSseMessages(raw: string): JsonRpcResponse[] {
  const lines = raw.split(/\r?\n/);
  const messages: JsonRpcResponse[] = [];

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      messages.push(parsed);
    } catch {
      continue;
    }
  }

  return messages;
}
