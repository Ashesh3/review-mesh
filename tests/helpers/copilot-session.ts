import { CopilotSession, type SessionEvent } from "@github/copilot-sdk";

// Exercise the shipped SDK's actual timers and event handling without launching
// a runtime or contacting a provider. These are internal transport fixture seams.
export type TestCopilotSession = CopilotSession & {
  _dispatchEvent(event: SessionEvent): void;
  _markDisconnected(): void;
};
type FixtureConnection = {
  sendRequest(method: string): Promise<unknown>;
};
const Session = CopilotSession as unknown as new (
  id: string,
  connection: FixtureConnection,
) => TestCopilotSession;

export function createTestCopilotSession(
  connection: FixtureConnection,
): TestCopilotSession {
  return new Session("completion-fixture", connection);
}
