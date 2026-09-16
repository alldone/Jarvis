export interface ProjectContext {
  cwd: string;
  name: string;
  documents: Record<string, string>;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; status: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'file-change'; path: string }
  | { type: 'approval'; request: { description: string } }
  | { type: 'error'; error: Error }
  | { type: 'done' };

export interface AgentInput {
  prompt: string;
  context: ProjectContext;
  readOnly?: boolean;
  allowEdits?: boolean;
  history?: string;
}

export interface AgentSession { id: string; cwd: string }
export interface Availability { available: boolean; detail: string }
export interface AgentProvider {
  id: string;
  availability(): Promise<Availability>;
  isAvailable(): Promise<boolean>;
  startSession(context: ProjectContext): Promise<AgentSession>;
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  passthrough?(command: string, input: AgentInput): AsyncIterable<AgentEvent>;
  nativeArgs(context: ProjectContext): string[];
  binary: string;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export type EventSink = (source: string, event: AgentEvent) => void;
