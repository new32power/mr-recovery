import type { Response } from "express";
import type { WebSocket } from "ws";

const sseClients = new Set<Response>();
const wsClients = new Set<WebSocket>();

export function sseSubscribe(res: Response): void {
  sseClients.add(res);
}

export function sseUnsubscribe(res: Response): void {
  sseClients.delete(res);
}

export function wsSubscribe(ws: WebSocket): void {
  wsClients.add(ws);
}

export function wsUnsubscribe(ws: WebSocket): void {
  wsClients.delete(ws);
}

export function sseEmit(event: string, data: unknown): void {
  const ssePayload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(ssePayload);
    } catch {
      sseClients.delete(client);
    }
  }

  const wsPayload = JSON.stringify({ event, data });
  for (const ws of wsClients) {
    try {
      ws.send(wsPayload);
    } catch {
      wsClients.delete(ws);
    }
  }
}
