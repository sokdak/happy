import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';

/** Uses Happy's existing permission RPC/state. Auto-approval policy stays in the ACP adapter. */
export class AgyPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix(): string { return '[agy]'; }

  handleToolCall(id: string, toolName: string, input: unknown): Promise<PermissionResult> {
    if (['change_title', 'happy__change_title', 'mcp__happy__change_title'].includes(toolName)) {
      return Promise.resolve({ decision: 'approved' });
    }
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, toolName, input });
      this.addPendingRequestToState(id, toolName, input);
    });
  }
}
