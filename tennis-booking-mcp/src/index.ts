import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	acquire,
	connect,
	limits,
	type Browser,
	type BrowserWorker,
	type Page,
} from "@cloudflare/playwright";
import { McpAgent } from "agents/mcp";
import { env as runtimeEnv } from "cloudflare:workers";
import { z } from "zod";

const REC_BASE_URL = "https://www.rec.us/sfrecpark";
const DEFAULT_COURT = "Potrero Hill";
const AVAILABILITY_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const PENDING_BOOKING_KEY = "pending_booking:default";
const BOOKING_KEY_PREFIX = "booking:";
const BROWSER_RELAUNCH_AFTER_MS = 9 * 60 * 1000;
const BROWSER_KEEP_ALIVE_MS = 10 * 60 * 1000;
const BROWSER_SESSION_KEY = "browser_session:default";
const BROWSER_SESSION_TTL_SECONDS = 60 * 60;
const BROWSER_ACQUIRE_MAX_ATTEMPTS = 6;
const BROWSER_ACQUIRE_BASE_DELAY_MS = 1_500;
const BROWSER_ACQUIRE_MAX_DELAY_MS = 30_000;
const PENDING_BOOKING_TTL_SECONDS = 60 * 60;
const BOOKING_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 180;

type PendingBooking = {
	court: string;
	time: string;
	date: string;
	timestamp: number;
};

type BookingRecord = PendingBooking & {
	status: "completed";
	confirmedAt: number;
};

type AvailabilitySnapshot = {
	court: string;
	date: string;
	availableTimes: string[];
	totalSlots: number;
	requestedTime: string | null;
	requestedTimeAvailable: boolean | null;
	error?: string;
};

function getEnv(): Env {
	return runtimeEnv as Env;
}

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function toIsoDate(dateInput?: string): string {
	const today = new Date();
	const input = dateInput?.trim().toLowerCase();

	if (!input || input === "tomorrow") {
		const tomorrow = new Date(today);
		tomorrow.setDate(today.getDate() + 1);
		return formatLocalDate(tomorrow);
	}

	if (input === "today") {
		return formatLocalDate(today);
	}

	if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
		return input;
	}

	const parsed = new Date(dateInput ?? "");
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(
			`Invalid date "${dateInput}". Use YYYY-MM-DD, "today", "tomorrow", or omit date for tomorrow.`,
		);
	}

	return formatLocalDate(parsed);
}

function normalizeTimeInput(raw: string): string {
	const trimmed = raw.trim().toUpperCase();
	const compact = trimmed.replace(/\s+/g, "");
	const amPm = compact.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)$/i);
	if (!amPm) {
		return trimmed;
	}

	const hour = amPm[1];
	const minute = amPm[2] ?? "00";
	const suffix = amPm[3];
	return `${hour}:${minute} ${suffix}`;
}

function parseJson<T>(raw: string | null): T | null {
	if (!raw) {
		return null;
	}

	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Tennis Court Booking",
		version: "1.0.0",
	});

	private browser: Browser | null = null;
	private browserSessionId: string | null = null;
	private browserInitPromise: Promise<void> | null = null;
	private lastBrowserInit = 0;
	private toolsInitialized = false;

	async init(): Promise<void> {
		if (this.toolsInitialized) {
			return;
		}
		this.toolsInitialized = true;

		this.server.tool(
			"check_tennis_courts",
			{
				date: z
					.string()
					.optional()
					.describe(
						"Date in YYYY-MM-DD format, 'today', 'tomorrow', or empty for tomorrow.",
					),
				court: z
					.string()
					.optional()
					.describe("Court name (for example: Potrero Hill, McLaren, Alice Marble)."),
				time: z.string().optional().describe("Preferred time (for example: 8:00 AM)."),
			},
			async ({ date, court, time }) => {
				const targetCourt = (court ?? DEFAULT_COURT).trim();
				const targetDate = toIsoDate(date);
				const requestedTime = time ? normalizeTimeInput(time) : null;

				const page = await this.newPageWithRecovery(15_000);

				const snapshot: AvailabilitySnapshot = {
					court: targetCourt,
					date: targetDate,
					availableTimes: [],
					totalSlots: 0,
					requestedTime,
					requestedTimeAvailable: null,
				};

				try {
					await this.openCourtPage(page, targetCourt);
					await this.selectDate(page, targetDate);
					await page.waitForSelector("text=/(\\d:)|(No free)/", { timeout: 10_000 });
					const availableTimes = await this.extractAvailableTimes(page);

					snapshot.availableTimes = availableTimes;
					snapshot.totalSlots = availableTimes.length;
					snapshot.requestedTimeAvailable = requestedTime
						? availableTimes.some((slot) =>
								slot.toLowerCase().includes(requestedTime.toLowerCase()),
							)
						: null;
				} catch (error) {
					snapshot.error = error instanceof Error ? error.message : "Unknown error";
				} finally {
					await page.close();
				}

				return {
					content: [
						{
							type: "text" as const,
							text: await this.summarizeAvailability(snapshot),
						},
					],
				};
			},
		);

		this.server.tool(
			"book_and_request_sms",
			{
				court: z.string().describe("Court name (for example: Potrero Hill)."),
				time: z.string().describe("Time slot (for example: 12:00 PM)."),
				date: z.string().describe("Date in YYYY-MM-DD format, 'today', or 'tomorrow'."),
			},
			async ({ court, time, date }) => {
				const targetCourt = court.trim();
				const targetTime = normalizeTimeInput(time);
				const targetDate = toIsoDate(date);

				const credentials = this.getCredentials();
				if (!credentials) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"REC_EMAIL and REC_PASSWORD are not set. Add them to `.dev.vars` for local dev " +
									"or set secrets with `wrangler secret put REC_EMAIL` and `wrangler secret put REC_PASSWORD`.",
							},
						],
					};
				}

				const page = await this.newPageWithRecovery(15_000);
				let keepPageOpen = false;

				try {
					await page.goto(REC_BASE_URL, {
						timeout: 25_000,
						waitUntil: "domcontentloaded",
					});
					await page.waitForSelector("text=Log In", { timeout: 15_000 });
					await page.getByText("Log In").first().click();
					await page.waitForSelector('input[id="email"]', { timeout: 12_000 });
					await page.fill('input[id="email"]', credentials.email);
					await page.fill('input[id="password"]', credentials.password);
					await page.getByText("log in & continue").first().click();
					await page.waitForTimeout(2_500);

					await this.openCourtPage(page, targetCourt);
					await this.selectDate(page, targetDate);
					await page.waitForSelector("text=/(\\d:)|(No free)/", { timeout: 10_000 });

					const availableTimes = await this.extractAvailableTimes(page);
					const resolvedTime =
						availableTimes.find(
							(slot) => slot.toLowerCase() === targetTime.toLowerCase(),
						) ??
						availableTimes.find((slot) =>
							slot.toLowerCase().includes(targetTime.toLowerCase()),
						);

					if (!resolvedTime) {
						throw new Error(
							`${targetTime} is not available. Available times: ${availableTimes.join(", ") || "none"}.`,
						);
					}

					await page.getByText(resolvedTime).first().click();
					await this.pickDurationAndParticipant(page);

					await page.locator("button.max-w-max").first().click();
					await page.getByText("Send Code").first().click();
					await page.waitForSelector('input[id="totp"]', { timeout: 12_000 });

					await this.storePendingBooking({
						court: targetCourt,
						time: resolvedTime,
						date: targetDate,
						timestamp: Date.now(),
					});

					keepPageOpen = true;
					return {
						content: [
							{
								type: "text" as const,
								text:
									`SMS code requested.\n\nCourt: ${targetCourt}\nTime: ${resolvedTime}\nDate: ${targetDate}\n\n` +
									`When your SMS code arrives, run:\n` +
									`enter_sms_code_and_complete({"code": "YOUR_SMS_CODE"})\n\n` +
									"Browser is waiting at the verification step.",
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Booking failed: ${error instanceof Error ? error.message : "Unknown error"}`,
							},
						],
					};
				} finally {
					if (!keepPageOpen) {
						await page.close();
					}
				}
			},
		);

		this.server.tool(
			"enter_sms_code_and_complete",
			{
				code: z.string().describe("SMS verification code sent to your phone."),
			},
			async ({ code }) => {
				const browser = await this.ensureBrowser();
				const verificationPage = await this.findSmsVerificationPage(browser);

				if (!verificationPage) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"No SMS verification page is open. Run `book_and_request_sms` first and wait " +
									"until the SMS input is visible.",
							},
						],
					};
				}

				try {
					await verificationPage.fill('input[id="totp"]', code.trim());
					await verificationPage.getByText("Confirm").last().click();

					try {
						await verificationPage.waitForSelector("text=You're all set!", {
							timeout: 180_000,
						});
					} catch {
						const bodyText = (await verificationPage.textContent("body")) ?? "";
						if (bodyText.includes("Court already reserved at this time")) {
							return {
								content: [
									{
										type: "text" as const,
										text: "Court already reserved at this time.",
									},
								],
							};
						}

						return {
							content: [
								{
									type: "text" as const,
									text: "Booking confirmation timed out. Check rec.us manually to confirm status.",
								},
							],
						};
					}

					const pending = await this.getPendingBooking();
					if (pending) {
						await this.saveCompletedBooking(pending);
						await this.clearPendingBooking();
					}

					return {
						content: [
							{
								type: "text" as const,
								text:
									"Booking completed. SMS code accepted and rec.us returned the " +
									'"You\'re all set!" confirmation.',
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to submit SMS code: ${error instanceof Error ? error.message : "Unknown error"}`,
							},
						],
					};
				}
			},
		);

		this.server.tool("test_browser", {}, async () => {
			try {
				const page = await this.newPageWithRecovery(15_000);
				await page.goto("https://example.com", { timeout: 15_000 });
				const title = await page.title();
				await page.close();

				return {
					content: [
						{
							type: "text" as const,
							text: `Browser binding is healthy. Test page title: "${title}".`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Browser test failed: ${error instanceof Error ? error.message : "Unknown error"}.\n` +
								`Make sure wrangler has "browser": { "binding": "MYBROWSER", "remote": true }.`,
						},
					],
				};
			}
		});

		this.server.tool(
			"get_booking_history",
			{
				days: z
					.number()
					.int()
					.min(1)
					.max(365)
					.optional()
					.describe("How many days to look back (default 30)."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Maximum rows to return (default 20)."),
			},
			async ({ days = 30, limit = 20 }) => {
				const bookings = await this.listBookingHistory(days, limit);
				if (bookings.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No completed bookings found in the last ${days} days.`,
							},
						],
					};
				}

				const lines = bookings.map(
					(booking) =>
						`- ${booking.date} | ${booking.court} | ${booking.time} | confirmed ${new Date(booking.confirmedAt).toISOString()}`,
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${bookings.length} booking(s) in the last ${days} days:\n${lines.join("\n")}`,
						},
					],
				};
			},
		);

		this.server.tool("auth_status", {}, async () => {
			const currentEnv = getEnv();
			const hasEmail = Boolean(currentEnv.REC_EMAIL);
			const hasPassword = Boolean(currentEnv.REC_PASSWORD);
			const hasBrowser = Boolean(currentEnv.MYBROWSER);
			const hasKV = Boolean(currentEnv.KV);
			const hasAI = Boolean(currentEnv.AI);

			return {
				content: [
					{
						type: "text" as const,
						text:
							"Auth mode: authless\n" +
							`REC_EMAIL set: ${hasEmail}\n` +
							`REC_PASSWORD set: ${hasPassword}\n` +
							`MYBROWSER binding: ${hasBrowser}\n` +
							`KV binding: ${hasKV}\n` +
							`AI binding: ${hasAI}\n` +
							`Ready to book: ${hasEmail && hasPassword && hasBrowser && hasKV}`,
					},
				],
			};
		});

		this.server.tool("get_auth_url", {}, async () => {
			return {
				content: [
					{
						type: "text" as const,
						text:
							"This server is authless. There is no external auth URL. " +
							"Set REC_EMAIL and REC_PASSWORD secrets to enable booking tools.",
					},
				],
			};
		});
	}

	private getCredentials(): { email: string; password: string } | null {
		const { REC_EMAIL, REC_PASSWORD } = getEnv();
		if (!REC_EMAIL || !REC_PASSWORD) {
			return null;
		}
		return { email: REC_EMAIL, password: REC_PASSWORD };
	}

	private async ensureBrowser(): Promise<Browser> {
		if (
			this.browser?.isConnected() &&
			Date.now() - this.lastBrowserInit < BROWSER_RELAUNCH_AFTER_MS
		) {
			return this.browser;
		}

		if (!this.browserInitPromise) {
			this.browserInitPromise = (async () => {
				const currentEnv = getEnv();
				if (!currentEnv.MYBROWSER) {
					throw new Error(
						'Missing MYBROWSER binding. Configure "browser.binding" in wrangler.jsonc.',
					);
				}

				await this.resetBrowser();

				const reusableSessionId =
					this.browserSessionId ?? (await this.getStoredBrowserSessionId());

				if (reusableSessionId) {
					const reused = await this.tryConnectToSession(
						currentEnv.MYBROWSER,
						reusableSessionId,
					);
					if (reused) {
						this.browser = reused;
						this.browserSessionId = reusableSessionId;
						this.lastBrowserInit = Date.now();
						return;
					}

					this.browserSessionId = null;
					await this.clearStoredBrowserSessionId();
				}

				const acquired = await this.acquireWithBackoff(currentEnv.MYBROWSER);
				this.browser = await connect(currentEnv.MYBROWSER, acquired.sessionId);
				this.browserSessionId = acquired.sessionId;
				await this.storeBrowserSessionId(acquired.sessionId);
				this.lastBrowserInit = Date.now();
			})().finally(() => {
				this.browserInitPromise = null;
			});
		}

		await this.browserInitPromise;
		if (!this.browser) {
			throw new Error("Browser initialization failed.");
		}
		return this.browser;
	}

	private async newPageWithRecovery(defaultTimeoutMs: number): Promise<Page> {
		const browser = await this.ensureBrowser();
		try {
			const page = await browser.newPage();
			page.setDefaultTimeout(defaultTimeoutMs);
			return page;
		} catch (error) {
			if (!this.isBrowserClosedError(error)) {
				throw error;
			}

			await this.resetBrowser();
			const recoveredBrowser = await this.ensureBrowser();
			const page = await recoveredBrowser.newPage();
			page.setDefaultTimeout(defaultTimeoutMs);
			return page;
		}
	}

	private async resetBrowser(): Promise<void> {
		if (this.browser) {
			try {
				await this.browser.close();
			} catch {
				// ignore stale browser close errors
			}
		}
		this.browser = null;
		this.lastBrowserInit = 0;
	}

	private async acquireWithBackoff(
		browserBinding: BrowserWorker,
	): Promise<{ sessionId: string }> {
		let backoffMs = BROWSER_ACQUIRE_BASE_DELAY_MS;

		for (let attempt = 1; attempt <= BROWSER_ACQUIRE_MAX_ATTEMPTS; attempt += 1) {
			try {
				return await acquire(browserBinding, { keep_alive: BROWSER_KEEP_ALIVE_MS });
			} catch (error) {
				if (
					!this.isBrowserRateLimitError(error) ||
					attempt === BROWSER_ACQUIRE_MAX_ATTEMPTS
				) {
					throw error;
				}

				const limitDelayMs = await this.getRateLimitDelayMs(browserBinding);
				const waitMs = Math.min(
					Math.max(backoffMs, limitDelayMs),
					BROWSER_ACQUIRE_MAX_DELAY_MS,
				);
				await this.sleep(waitMs);
				backoffMs = Math.min(backoffMs * 2, BROWSER_ACQUIRE_MAX_DELAY_MS);
			}
		}

		throw new Error("Unable to acquire browser session after retries.");
	}

	private async getRateLimitDelayMs(browserBinding: BrowserWorker): Promise<number> {
		try {
			const currentLimits = await limits(browserBinding);
			const rawDelay = currentLimits.timeUntilNextAllowedBrowserAcquisition;
			if (!rawDelay || rawDelay <= 0) {
				return BROWSER_ACQUIRE_BASE_DELAY_MS;
			}
			// Cloudflare returns seconds in some contexts and milliseconds in others.
			return rawDelay < 1_000 ? rawDelay * 1_000 : rawDelay;
		} catch {
			return BROWSER_ACQUIRE_BASE_DELAY_MS;
		}
	}

	private async tryConnectToSession(
		browserBinding: BrowserWorker,
		sessionId: string,
	): Promise<Browser | null> {
		try {
			return await connect(browserBinding, sessionId);
		} catch (error) {
			if (this.isBrowserSessionNotReusableError(error)) {
				return null;
			}
			throw error;
		}
	}

	private async storeBrowserSessionId(sessionId: string): Promise<void> {
		await getEnv().KV.put(BROWSER_SESSION_KEY, sessionId, {
			expirationTtl: BROWSER_SESSION_TTL_SECONDS,
		});
	}

	private async getStoredBrowserSessionId(): Promise<string | null> {
		return getEnv().KV.get(BROWSER_SESSION_KEY);
	}

	private async clearStoredBrowserSessionId(): Promise<void> {
		await getEnv().KV.delete(BROWSER_SESSION_KEY);
	}

	private isBrowserRateLimitError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const message = error.message.toLowerCase();
		return message.includes("code: 429") || message.includes("rate limit exceeded");
	}

	private isBrowserSessionNotReusableError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const message = error.message.toLowerCase();
		return (
			message.includes("code: 404") ||
			message.includes("session not found") ||
			message.includes("session does not exist") ||
			message.includes("closed") ||
			message.includes("disconnected")
		);
	}

	private async sleep(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	private isBrowserClosedError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const message = error.message.toLowerCase();
		return (
			message.includes("target page, context or browser has been closed") ||
			message.includes("browser has been closed") ||
			message.includes("browser has disconnected")
		);
	}

	private async openCourtPage(page: Page, court: string): Promise<void> {
		await page.goto(REC_BASE_URL, { timeout: 25_000, waitUntil: "domcontentloaded" });
		await page.waitForSelector(`text=${court}`, { timeout: 15_000 });
		await page.getByText(court).first().click();
		await page.waitForSelector("text=Court Reservations", { timeout: 12_000 });
	}

	private async selectDate(page: Page, isoDate: string): Promise<void> {
		const targetDate = new Date(`${isoDate}T00:00:00`);
		if (Number.isNaN(targetDate.getTime())) {
			throw new Error(`Invalid date: ${isoDate}`);
		}

		await page.locator("input").first().click();
		await page.waitForSelector(".react-datepicker", { timeout: 8_000 });

		const today = new Date();
		const monthDiff =
			(targetDate.getFullYear() - today.getFullYear()) * 12 +
			(targetDate.getMonth() - today.getMonth());
		const day = targetDate.getDate();
		const daySelector = `.react-datepicker__day--0${day < 10 ? "0" : ""}${day}:not(.react-datepicker__day--outside-month)`;

		if (monthDiff > 0) {
			for (let step = 0; step < monthDiff; step += 1) {
				await page.getByRole("button", { name: /right|next/i }).click();
			}
		} else if (monthDiff < 0) {
			for (let step = 0; step < Math.abs(monthDiff); step += 1) {
				await page.getByRole("button", { name: /left|prev/i }).click();
			}
		}

		await page.locator(daySelector).first().click();
	}

	private async extractAvailableTimes(page: Page): Promise<string[]> {
		try {
			const raw = await page
				.getByText("Tennis")
				.first()
				.evaluate(
					(element: { parentElement: { innerText?: string | undefined } | null }) =>
						element.parentElement?.innerText ?? "",
				);

			const fromSection = raw
				.split("\n")
				.map((line: string) => line.trim())
				.filter((line: string) => /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/i.test(line))
				.map((line: string) => line.toUpperCase());

			if (fromSection.length > 0) {
				return Array.from(new Set(fromSection));
			}
		} catch {
			// fall through to body parser
		}

		const body = (await page.textContent("body")) ?? "";
		const matches = body.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/gi) ?? [];
		return Array.from(new Set(matches.map((value) => value.toUpperCase())));
	}

	private async pickDurationAndParticipant(page: Page): Promise<void> {
		try {
			await page
				.locator("xpath=//label[text()='Duration']/following-sibling::button")
				.click();
			await page.waitForSelector("div[role='option']", { timeout: 5_000 });
			await page.locator("div[role='option']:not([aria-disabled='true'])").first().click();
		} catch {
			// Duration selector can differ per facility; continue with default duration.
		}

		try {
			await page.getByText("Select participant").click();
			await page.getByText("Account Owner").click();
		} catch {
			// Participant picker is not always required.
		}
	}

	private async findSmsVerificationPage(browser: Browser): Promise<Page | null> {
		for (const context of browser.contexts()) {
			for (const page of context.pages()) {
				try {
					const visible = await page
						.locator('input[id="totp"]')
						.isVisible({ timeout: 800 });
					if (visible) {
						return page;
					}
				} catch {
					// continue scanning pages
				}
			}
		}
		return null;
	}

	private async summarizeAvailability(snapshot: AvailabilitySnapshot): Promise<string> {
		if (snapshot.error) {
			return `Could not check ${snapshot.court} on ${snapshot.date}: ${snapshot.error}`;
		}

		const fallback = this.summarizeAvailabilityFallback(snapshot);
		const currentEnv = getEnv();
		if (!currentEnv.AI) {
			return fallback;
		}

		try {
			const messages = [
				{
					role: "system",
					content:
						"You are a concise tennis booking assistant. Summarize availability with a direct recommendation.",
				},
				{
					role: "user",
					content: JSON.stringify(snapshot),
				},
			];
			const aiResponse = (await currentEnv.AI.run(AVAILABILITY_MODEL as keyof AiModels, {
				messages,
			})) as { response?: string };
			const text = aiResponse.response?.trim();
			return text && text.length > 0 ? text : fallback;
		} catch {
			return fallback;
		}
	}

	private summarizeAvailabilityFallback(snapshot: AvailabilitySnapshot): string {
		if (snapshot.totalSlots === 0) {
			return `No free tennis slots found at ${snapshot.court} on ${snapshot.date}.`;
		}

		const lines = [
			`${snapshot.court} has ${snapshot.totalSlots} slot(s) on ${snapshot.date}.`,
			`Available: ${snapshot.availableTimes.join(", ")}.`,
		];

		if (snapshot.requestedTime) {
			lines.push(
				snapshot.requestedTimeAvailable
					? `Requested time ${snapshot.requestedTime} is available.`
					: `Requested time ${snapshot.requestedTime} is not available.`,
			);
		}

		return lines.join(" ");
	}

	private async storePendingBooking(pending: PendingBooking): Promise<void> {
		await getEnv().KV.put(PENDING_BOOKING_KEY, JSON.stringify(pending), {
			expirationTtl: PENDING_BOOKING_TTL_SECONDS,
		});
	}

	private async getPendingBooking(): Promise<PendingBooking | null> {
		const pending = parseJson<PendingBooking>(await getEnv().KV.get(PENDING_BOOKING_KEY));
		if (!pending) {
			return null;
		}

		if (Date.now() - pending.timestamp > PENDING_BOOKING_TTL_SECONDS * 1000) {
			await this.clearPendingBooking();
			return null;
		}

		return pending;
	}

	private async clearPendingBooking(): Promise<void> {
		await getEnv().KV.delete(PENDING_BOOKING_KEY);
	}

	private async saveCompletedBooking(pending: PendingBooking): Promise<void> {
		const confirmedAt = Date.now();
		const key = `${BOOKING_KEY_PREFIX}${pending.date}:${pending.timestamp}`;
		const record: BookingRecord = {
			...pending,
			status: "completed",
			confirmedAt,
		};
		await getEnv().KV.put(key, JSON.stringify(record), {
			expirationTtl: BOOKING_HISTORY_TTL_SECONDS,
		});
	}

	private async listBookingHistory(days: number, limit: number): Promise<BookingRecord[]> {
		const keys = await getEnv().KV.list({
			prefix: BOOKING_KEY_PREFIX,
			limit: Math.min(300, limit * 8),
		});
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const records: BookingRecord[] = [];

		for (const key of keys.keys) {
			const raw = await getEnv().KV.get(key.name);
			const record = parseJson<BookingRecord>(raw);
			if (!record) {
				continue;
			}
			if (record.confirmedAt < cutoff) {
				continue;
			}
			records.push(record);
		}

		return records.sort((a, b) => b.confirmedAt - a.confirmedAt).slice(0, limit);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
					"Access-Control-Max-Age": "86400",
				},
			});
		}

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		if (url.pathname === "/") {
			return new Response(
				`Tennis Court Booking MCP Server

Tools:
- check_tennis_courts
- book_and_request_sms
- enter_sms_code_and_complete
- test_browser
- get_booking_history
- auth_status
- get_auth_url

Endpoints:
- SSE: /sse
- MCP: /mcp`,
				{
					status: 200,
					headers: { "Content-Type": "text/plain" },
				},
			);
		}

		return new Response("Not found", { status: 404 });
	},
};
