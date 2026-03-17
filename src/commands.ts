import type { SessionManager } from "./session/manager.ts";

export function pick(messages: string[]): string {
	// biome-ignore lint/style/noNonNullAssertion: array is always non-empty
	return messages[Math.floor(Math.random() * messages.length)]!;
}

const START_MESSAGES = [
	// Classic cinema
	"Hey, I'm Bae. You had me at /start.", // Jerry Maguire
	"This is the beginning of a beautiful friendship.", // Casablanca
	"You talking to me? Good. I'm Bae.", // Taxi Driver
	"Where we're going, we don't need GUIs.", // Back to the Future
	// Sci-fi
	"Wake up, Neo. Your agents are waiting.", // The Matrix
	"I've seen things you people wouldn't believe. Ready when you are.", // Blade Runner
	"It's not possible. No, it's necessary.", // Interstellar
	// Games & anime
	"It's dangerous to go alone. Take me.", // Zelda
	"Hey! Listen!", // Navi, Zelda
	"A new challenger approaches.", // Smash Bros
	"Omae wa mou... connected.", // Fist of the North Star
	// TV
	"Say my name. It's Bae.", // Breaking Bad
	"I am the one who connects.", // Breaking Bad
	// Music & culture
	"Who you gonna call? ...Me. I'm Bae.", // Ghostbusters
	"Hello from the other side. Of the API.", // Adele
	// Original
	"I'm Bae. Line to your agents. Fire away.",
	"Bae here. Your agents are just a message away.",
];

const NEW_ACTIVE_MESSAGES = [
	// Classic cinema
	"Hasta la vista, session.", // Terminator 2
	"I see dead sessions. This one's gone.", // The Sixth Sense
	"After all, tomorrow is another day.", // Gone with the Wind
	"Forget it, Jake. It's a new session.", // Chinatown
	// Sci-fi
	"He's beginning to believe... in fresh starts.", // The Matrix
	"All those moments, lost in time. Like tears in rain.", // Blade Runner
	"We used to look up and wonder. Now let's wonder again.", // Interstellar
	// Games & anime
	"Session defeated! You gained EXP.", // RPG
	"FINISH HIM! ...Done. New session.", // Mortal Kombat
	"Nothing happened. (save corrupted)", // classic game energy
	// TV
	"I am the danger. And the danger says: fresh start.", // Breaking Bad
	// Music & culture
	"Thank u, next.", // Ariana Grande
	// Original
	"Poof, gone. What's next?",
	"That conversation? Never heard of it.",
	"Ctrl+Z'd into oblivion.",
];

const NEW_IDLE_MESSAGES = [
	// Classic cinema
	"As you wish.", // The Princess Bride
	"Here's looking at you, kid.", // Casablanca
	"Roads? Where we're going we don't need roads.", // Back to the Future
	// Sci-fi
	"There is no spoon. Only a fresh session.", // The Matrix
	"The future is not set. Go.", // Terminator 2
	"Do not go gentle. Type something.", // Interstellar / Dylan Thomas
	// Games & anime
	"A new quest awaits!", // RPG
	"Press START to continue.", // every game ever
	"Your princess is in another session. This one's yours.", // Mario
	// TV
	"So anyway, I started typing.", // It's Always Sunny
	// Music & culture
	"Hello, is it me you're looking for?", // Lionel Richie
	"I got one more in me.", // Eminem
	// Original
	"Ready when you are.",
	"Standing by. What's the play?",
	"The floor is yours.",
];

// Stream crash — Bae lost connection to the agent mid-conversation
export const ERROR_STREAM_MESSAGES = [
	// Sci-fi
	"I've lost the signal, Captain. Try again.", // Star Trek energy
	"Connection terminated. Like tears in rain.", // Blade Runner
	"The matrix glitched. Send that again.", // The Matrix
	"We've gone to plaid. Try once more.", // Spaceballs
	// Games
	"Connection lost! Respawning in 3... 2... 1... go.", // FPS
	"The session has died. Continue? Send your message again.", // arcade
	"Link between worlds lost. Send again.", // Zelda
	// TV & film
	"Lost my train of thought. Where were we?", // casual
	"Well, that escalated quickly. Try again.", // Anchorman
	"I'll be back. Actually, I'm back. Go again.", // Terminator
	// Original
	"Something broke mid-stream. Send that again.",
];

// Spawn failure — couldn't start or route the message
export const ERROR_SPAWN_MESSAGES = [
	// Sci-fi
	"I can't let you do that, Dave. Actually I can, just not right now.", // 2001
	"Engage! ...failed. Try rephrasing or /new.", // Star Trek
	"The portal gun misfired. Try again or /new.", // Portal / Rick and Morty
	// Games
	"404: Agent not found. Try /new.", // web classic
	"It's a-me, Error! Try rephrasing or /new.", // Mario
	"You died. But unlike Dark Souls, you can just /new.", // Dark Souls
	// TV & film
	"Houston, we have a problem. Try again or /new.", // Apollo 13
	"Not great, not terrible. Send again or /new.", // Chernobyl
	"That didn't go according to plan. Rephrase or /new.", // generic heist
	// Original
	"Couldn't get through. Try rephrasing or /new.",
];

// Agent error — the agent itself reported a problem
export const ERROR_AGENT_MESSAGES = [
	// Sci-fi
	"The agent went into the upside down. Send /new.", // Stranger Things
	"My agent had a malfunction. Send /new to reboot.", // sci-fi
	"Doesn't look like anything to me. Try /new.", // Westworld
	// Games
	"GAME OVER. Insert /new to continue.", // arcade
	"The agent took an arrow to the knee. Try /new.", // Skyrim
	"Agent.exe has stopped working. /new to restart.", // Windows
	// TV & film
	"The agent needs a moment. Send /new for a fresh start.", // therapy energy
	"I've made a huge mistake. Try /new.", // Arrested Development
	"We need to go back! Send /new.", // Lost
	// Music
	"It's been a long day without you, my friend. Send /new.", // Wiz Khalifa
	// Original
	"Something went sideways. Send /new to start fresh.",
];

/**
 * Handle Bae-level commands that the agent can't handle itself.
 * Minimal by design — Bae is invisible infrastructure, not a chatbot.
 *
 * Returns a response string if the command was handled, or null to pass through to the agent.
 */
export async function handleCommand(
	text: string,
	sessionManager: SessionManager,
	channelId: string,
	conversationId: string,
): Promise<string | null> {
	// Telegram convention: /start is sent when user first opens the bot
	if (text === "/start") {
		return pick(START_MESSAGES);
	}

	// /new kills active process and clears the agent session
	if (text === "/new") {
		const wasActive = await sessionManager.interruptSession(
			channelId,
			conversationId,
		);
		sessionManager.clearSession(channelId, conversationId);
		return wasActive ? pick(NEW_ACTIVE_MESSAGES) : pick(NEW_IDLE_MESSAGES);
	}

	// Everything else goes to the agent
	return null;
}
