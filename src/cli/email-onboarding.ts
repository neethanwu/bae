import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import {
	deleteChannelCredentials,
	readChannelCredentials,
} from "../credentials.ts";
import type { Store } from "../session/store.ts";

/**
 * Resolve an AgentMail API key — reuse an existing one from another
 * email channel if available, otherwise guide the user through signup.
 */
export async function resolveApiKey(store: Store): Promise<string> {
	// Step 1: Check for existing API key across all email channels
	const allChannels = store.listChannels();
	const emailChannels = allChannels.filter((ch) => ch.platform === "email");
	const existingKeys = new Set<string>();

	for (const ch of emailChannels) {
		const creds = readChannelCredentials(ch.id);
		if (creds.AGENTMAIL_API_KEY) {
			existingKeys.add(creds.AGENTMAIL_API_KEY);
		}
	}

	// If we found an existing key, offer to reuse it
	if (existingKeys.size > 0) {
		const existingKey = [...existingKeys][0] as string;
		p.log.info("You already have an AgentMail account connected.");

		const reuse = await p.confirm({
			message: "Use your existing AgentMail account?",
		});
		if (p.isCancel(reuse)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		if (reuse) {
			const { validateApiKey } = await import("../platform/email/api.ts");
			const result = await validateApiKey(existingKey);
			if (result.valid) {
				return existingKey;
			}
			p.log.warn("Stored API key is no longer valid. Let's set up a new one.");
		}
		// Fall through to step 2
	}

	// Step 2: Show instructions + paste prompt
	p.log.info(
		"You'll need an AgentMail API key (free account).\n\n" +
			"  If you don't have one:\n" +
			"  1. Go to https://console.agentmail.to\n" +
			"  2. Sign up or log in\n" +
			"  3. Settings → API Keys → Create API Key\n" +
			"  4. Copy the key",
	);

	// Attempt to open browser
	try {
		if (process.platform === "darwin") {
			execSync('open "https://console.agentmail.to"');
		} else {
			execSync('xdg-open "https://console.agentmail.to"');
		}
	} catch {
		// Fails silently on headless/SSH
	}

	const apiKey = await p.text({
		message: "API key:",
		validate: (val) => {
			if (!val?.trim()) return "API key is required";
		},
	});
	if (p.isCancel(apiKey)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	// Validate the key
	const { validateApiKey } = await import("../platform/email/api.ts");
	const result = await validateApiKey(apiKey);
	if (!result.valid) {
		p.log.error("Invalid API key.");
		process.exit(1);
	}
	p.log.success(
		`Connected to AgentMail (${result.inboxCount} inbox${result.inboxCount === 1 ? "" : "es"})`,
	);
	return apiKey;
}

interface ResolveInboxResult {
	inboxId: string;
	email: string;
}

interface BoundInboxInfo {
	inboxId: string;
	email: string;
	channelId: string;
	workspaceId: string;
}

/**
 * Resolve which AgentMail inbox to use for this workspace — pick an
 * existing unbound inbox, create a new one, or reassign a bound one.
 */
export async function resolveInbox(
	client: import("agentmail").AgentMailClient,
	store: Store,
	_apiKey: string,
	workspaceSlug: string,
): Promise<ResolveInboxResult> {
	const { listInboxes } = await import("../platform/email/api.ts");

	// List all inboxes on the account
	const allInboxes = await listInboxes(client);

	// Get bound inbox IDs from existing email channels
	const allChannels = store.listChannels();
	const emailChannels = allChannels.filter((ch) => ch.platform === "email");
	const boundMap = new Map<string, BoundInboxInfo>();

	for (const ch of emailChannels) {
		const creds = readChannelCredentials(ch.id);
		if (creds.AGENTMAIL_INBOX_ID) {
			const inbox = allInboxes.find(
				(i) => i.inboxId === creds.AGENTMAIL_INBOX_ID,
			);
			boundMap.set(creds.AGENTMAIL_INBOX_ID, {
				inboxId: creds.AGENTMAIL_INBOX_ID,
				email: inbox?.email ?? creds.AGENTMAIL_INBOX_ID,
				channelId: ch.id,
				workspaceId: ch.workspaceId,
			});
		}
	}

	const available = allInboxes.filter((i) => !boundMap.has(i.inboxId));
	const canCreate = allInboxes.length < 3;

	// ── Case: 0 total inboxes OR (0 unbound and can create) ──
	if (allInboxes.length === 0 || (available.length === 0 && canCreate)) {
		const result = await createInboxFlow(client, workspaceSlug);
		return result;
	}

	// ── Case: 0 unbound, at limit (all bound) ──
	if (available.length === 0 && !canCreate) {
		const boundInboxes = [...boundMap.values()];
		return await reassignmentFlow(client, store, boundInboxes, workspaceSlug);
	}

	// ── Case: 1+ unbound inboxes ──
	const options: { value: string; label: string }[] = available.map((i) => ({
		value: i.inboxId,
		label: i.email,
	}));

	if (canCreate) {
		options.push({ value: "__create__", label: "Create new inbox" });
	}

	const choice = await p.select({
		message: "Select an inbox for this workspace:",
		options,
	});
	if (p.isCancel(choice)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	if (choice === "__create__") {
		const result = await createInboxFlow(client, workspaceSlug);
		return result;
	}

	const selected = available.find((i) => i.inboxId === choice);
	if (!selected) {
		p.log.error("Selected inbox not found.");
		process.exit(1);
	}

	p.log.success(`Your agent's email: ${selected.email}`);
	p.log.info("Send an email to this address to talk to your agent.");
	return { inboxId: selected.inboxId, email: selected.email };
}

// ── Internal helpers ────────────────────────────────────────────────────

async function createInboxFlow(
	client: import("agentmail").AgentMailClient,
	workspaceSlug: string,
): Promise<ResolveInboxResult> {
	const { createInbox, listInboxes } = await import("../platform/email/api.ts");

	let defaultName = workspaceSlug;

	for (;;) {
		const name = await p.text({
			message: "Name your agent's email address:",
			defaultValue: defaultName,
			placeholder: defaultName,
		});
		if (p.isCancel(name)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		try {
			const inbox = await createInbox(client, name);
			p.log.success(`Your agent's email: ${inbox.email}`);
			p.log.info("Send an email to this address to talk to your agent.");
			return { inboxId: inbox.inboxId, email: inbox.email };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("409") || msg.toLowerCase().includes("conflict")) {
				p.log.warn(`${name}@agentmail.to is already taken.`);
				defaultName = `${name}-agent`;
				continue;
			}
			if (msg.includes("429") || msg.toLowerCase().includes("quota")) {
				// Quota error — fall back to picker if inboxes exist
				p.log.warn("Inbox creation limit reached.");
				const existing = await listInboxes(client);
				if (existing.length > 0) {
					p.log.info("Select an existing inbox instead.");
					const choice = await p.select({
						message: "Select an inbox:",
						options: existing.map((i) => ({
							value: i.inboxId,
							label: i.email,
						})),
					});
					if (p.isCancel(choice)) {
						p.cancel("Setup cancelled.");
						process.exit(0);
					}
					const selected = existing.find((i) => i.inboxId === choice);
					if (!selected) {
						p.log.error("Selected inbox not found.");
						process.exit(1);
					}
					p.log.success(`Your agent's email: ${selected.email}`);
					p.log.info("Send an email to this address to talk to your agent.");
					return { inboxId: selected.inboxId, email: selected.email };
				}
				p.log.error("Cannot create inbox and no existing inboxes found.");
				process.exit(1);
			}
			// Unknown error
			p.log.error(`Failed to create inbox: ${msg}`);
			process.exit(1);
		}
	}
}

async function reassignmentFlow(
	client: import("agentmail").AgentMailClient,
	store: Store,
	boundInboxes: BoundInboxInfo[],
	workspaceSlug: string,
): Promise<ResolveInboxResult> {
	const { listInboxes } = await import("../platform/email/api.ts");

	for (;;) {
		p.log.warn("All 3 inboxes are in use by other workspaces.");

		const options: { value: string; label: string }[] = boundInboxes.map(
			(info, i) => ({
				value: `move:${i}`,
				label: `Move ${info.email} here (currently on '${info.workspaceId}')`,
			}),
		);
		options.push(
			{
				value: "upgrade",
				label: "Upgrade AgentMail to create more inboxes",
			},
			{ value: "cancel", label: "Cancel" },
		);

		const choice = await p.select({
			message: "What would you like to do?",
			options,
		});
		if (p.isCancel(choice)) {
			p.cancel("Setup cancelled.");
			process.exit(0);
		}

		if (choice === "cancel") {
			p.cancel("Cancelled.");
			process.exit(0);
		}

		if (choice === "upgrade") {
			try {
				if (process.platform === "darwin") {
					execSync('open "https://console.agentmail.to/billing"');
				} else {
					execSync('xdg-open "https://console.agentmail.to/billing"');
				}
			} catch {
				// Fails silently
			}
			p.log.info(
				"Open https://console.agentmail.to/billing to upgrade your plan.",
			);

			// After upgrade, re-check — user may have created a new inbox
			const refreshed = await listInboxes(client);
			if (refreshed.length > boundInboxes.length) {
				// New inbox appeared — offer it
				const boundIds = new Set(boundInboxes.map((b) => b.inboxId));
				const newInboxes = refreshed.filter((i) => !boundIds.has(i.inboxId));
				if (newInboxes.length > 0) {
					const pick = await p.select({
						message: "Select your new inbox:",
						options: newInboxes.map((i) => ({
							value: i.inboxId,
							label: i.email,
						})),
					});
					if (p.isCancel(pick)) {
						p.cancel("Setup cancelled.");
						process.exit(0);
					}
					const selected = newInboxes.find((i) => i.inboxId === pick);
					if (!selected) {
						p.log.error("Selected inbox not found.");
						process.exit(1);
					}
					p.log.success(`Your agent's email: ${selected.email}`);
					p.log.info("Send an email to this address to talk to your agent.");
					return { inboxId: selected.inboxId, email: selected.email };
				}
			}

			// Still at limit — can try creating one now
			const canCreateNow = refreshed.length < 3;
			if (canCreateNow) {
				return await createInboxFlow(client, workspaceSlug);
			}

			// Loop back to reassignment
			continue;
		}

		// Handle move:N
		const moveMatch = (choice as string).match(/^move:(\d+)$/);
		if (moveMatch?.[1]) {
			const idx = Number.parseInt(moveMatch[1], 10);
			const target = boundInboxes[idx];
			if (!target) {
				p.log.error("Invalid selection.");
				continue;
			}

			const confirmed = await p.confirm({
				message: `This will remove the email channel from workspace '${target.workspaceId}'. The inbox ${target.email} will be used by this workspace instead. Continue?`,
			});
			if (p.isCancel(confirmed)) {
				p.cancel("Setup cancelled.");
				process.exit(0);
			}
			if (!confirmed) {
				continue;
			}

			// Remove old channel + credentials
			store.deleteChannel(target.channelId);
			deleteChannelCredentials(target.channelId);

			p.log.success(`Your agent's email: ${target.email}`);
			p.log.info("Send an email to this address to talk to your agent.");
			return { inboxId: target.inboxId, email: target.email };
		}
	}
}
