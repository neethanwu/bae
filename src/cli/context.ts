import { resolve } from "node:path";
import type { Store } from "../session/store.ts";
import type { Workspace } from "../session/types.ts";

/**
 * Detect if the current working directory matches an existing workspace.
 * Returns the workspace if found, null otherwise.
 */
export function detectCurrentWorkspace(store: Store): Workspace | null {
	const cwd = resolve(process.cwd());
	return store.listWorkspaces().find((ws) => resolve(ws.path) === cwd) ?? null;
}
