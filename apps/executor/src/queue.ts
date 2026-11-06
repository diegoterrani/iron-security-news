import type { QueueName } from "@ironnews/shared";
import type { Pool } from "./db";

/** Envelope padrão das mensagens (§6.6). */
export interface Envelope<T = Record<string, unknown>> {
  v: 1;
  traceId: string;
  attempt: number;
  payload: T;
}

export interface QueueMessage<T> {
  msgId: number;
  readCt: number;
  body: Envelope<T>;
}

export const MAX_ATTEMPTS = 5;

/** Backoff exponencial com teto: 30 s, 60 s, 120 s, 240 s, 480 s… máx. 30 min. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 1800);
}

export class Queue {
  constructor(private readonly pool: Pool) {}

  async send<T>(queue: QueueName, payload: T, opts: { traceId: string; attempt?: number; delaySec?: number }) {
    const body: Envelope<T> = { v: 1, traceId: opts.traceId, attempt: opts.attempt ?? 1, payload };
    const { rows } = await this.pool.query<{ id: string }>(
      "select pgmq.send($1, $2::jsonb, $3) as id",
      [queue, JSON.stringify(body), opts.delaySec ?? 0],
    );
    return Number(rows[0]?.id);
  }

  async read<T>(queue: QueueName, visibilitySec = 300, qty = 5): Promise<QueueMessage<T>[]> {
    const { rows } = await this.pool.query<{ msg_id: string; read_ct: number; message: Envelope<T> }>(
      "select msg_id, read_ct, message from pgmq.read($1, $2, $3)",
      [queue, visibilitySec, qty],
    );
    return rows.map((r) => ({ msgId: Number(r.msg_id), readCt: r.read_ct, body: r.message }));
  }

  async ack(queue: QueueName, msgId: number) {
    await this.pool.query("select pgmq.archive($1, $2::bigint)", [queue, msgId]);
  }

  /** Reenfileira com backoff ou move para a DLQ após MAX_ATTEMPTS. Retorna o destino. */
  async retryOrDeadLetter<T>(queue: QueueName, msg: QueueMessage<T>, error: string): Promise<"retry" | "dlq"> {
    const next = msg.body.attempt + 1;
    if (next > MAX_ATTEMPTS) {
      await this.send("dlq", { queue, original: msg.body, error }, { traceId: msg.body.traceId, attempt: next });
      await this.ack(queue, msg.msgId);
      return "dlq";
    }
    await this.send(queue, msg.body.payload, {
      traceId: msg.body.traceId,
      attempt: next,
      delaySec: backoffSeconds(next),
    });
    await this.ack(queue, msg.msgId);
    return "retry";
  }
}
