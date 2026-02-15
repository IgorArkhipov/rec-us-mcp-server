import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";

const REC_BASE_URL = "https://www.rec.us/sfrecpark";
const DEFAULT_COURT = "Potrero Hill";
const DEFAULT_SUBCOURTS = ["Court 1", "Court 2"];
const LOCAL_HEADLESS = process.env.LOCAL_BROWSER_HEADLESS !== "false";
const SCREENSHOT_DIR = path.resolve(process.cwd(), "artifacts", "screenshots");
const CAPTURE_SCREENSHOTS = process.env.LOCAL_BROWSER_CAPTURE_SCREENSHOTS !== "false";
const DEFAULT_PAGE_TIMEOUT_MS = 20_000;

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

let browser: Browser | null = null;
let pendingBooking: PendingBooking | null = null;
let activeVerificationPage: Page | null = null;
const completedBookings: BookingRecord[] = [];
let operationQueue: Promise<unknown> = Promise.resolve();

function withLock<T>(operation: () => Promise<T>): Promise<T> {
	const run = operationQueue.then(operation, operation);
	operationQueue = run.catch(() => undefined);
	return run;
}

async function loadDevVars(): Promise<void> {
	const varsPath = path.resolve(process.cwd(), ".dev.vars");
	try {
		const raw = await fs.readFile(varsPath, "utf8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) {
				continue;
			}
			const eq = trimmed.indexOf("=");
			if (eq < 0) {
				continue;
			}
			const key = trimmed.slice(0, eq).trim();
			const value = trimmed
				.slice(eq + 1)
				.trim()
				.replace(/^['"]|['"]$/g, "");
			if (!(key in process.env)) {
				process.env[key] = value;
			}
		}
	} catch {
		// Optional file; environment variables may already be provided by caller.
	}
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
			`Invalid date "${dateInput}". Use YYYY-MM-DD, "today", "tomorrow", or omit for tomorrow.`,
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
	return `${amPm[1]}:${amPm[2] ?? "00"} ${amPm[3]}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSubcourtPreferences(input?: string[]): string[] {
	if (input && input.length > 0) {
		return Array.from(new Set(input.map((value) => value.trim()).filter(Boolean)));
	}

	const envValue = process.env.LOCAL_BROWSER_SUBCOURTS?.trim();
	if (!envValue) {
		return [...DEFAULT_SUBCOURTS];
	}

	return Array.from(
		new Set(
			envValue
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	);
}

function sanitizeFileComponent(raw: string): string {
	return raw.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
}

function toReadableError(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

function isClosedBrowserError(error: unknown): boolean {
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

async function ensureBrowser(): Promise<Browser> {
	if (browser?.isConnected()) {
		return browser;
	}
	if (browser) {
		try {
			await browser.close();
		} catch {
			// ignore stale close errors
		}
		browser = null;
	}
	browser = await chromium.launch({
		headless: LOCAL_HEADLESS,
		args: LOCAL_HEADLESS ? [] : ["--start-maximized"],
	});
	return browser;
}

async function newPageWithRecovery(defaultTimeoutMs = DEFAULT_PAGE_TIMEOUT_MS): Promise<Page> {
	try {
		const currentBrowser = await ensureBrowser();
		const page = await currentBrowser.newPage(
			LOCAL_HEADLESS ? { viewport: { width: 1920, height: 1080 } } : { viewport: null },
		);
		page.setDefaultTimeout(defaultTimeoutMs);
		return page;
	} catch (error) {
		if (!isClosedBrowserError(error)) {
			throw error;
		}
		browser = null;
		const recoveredBrowser = await ensureBrowser();
		const page = await recoveredBrowser.newPage(
			LOCAL_HEADLESS ? { viewport: { width: 1920, height: 1080 } } : { viewport: null },
		);
		page.setDefaultTimeout(defaultTimeoutMs);
		return page;
	}
}

async function captureFailureScreenshot(page: Page | null, label: string): Promise<string | null> {
	if (!CAPTURE_SCREENSHOTS || !page || page.isClosed()) {
		return null;
	}
	try {
		await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `${sanitizeFileComponent(label)}-${timestamp}.png`;
		const filepath = path.join(SCREENSHOT_DIR, filename);
		await page.screenshot({ path: filepath, fullPage: true });
		return filepath;
	} catch {
		return null;
	}
}

async function fillLoginForm(
	page: Page,
	credentials: { email: string; password: string },
): Promise<void> {
	await page.waitForSelector("text=Log In", { timeout: 15_000 });
	await page.getByText("Log In").first().click();

	if (await page.locator('input[name="email"]').count()) {
		await page.fill('input[name="email"]', credentials.email);
	} else if (await page.locator('input[id="email"]').count()) {
		await page.fill('input[id="email"]', credentials.email);
	} else {
		throw new Error("Could not find login email input.");
	}

	if (await page.locator('input[name="password"]').count()) {
		await page.fill('input[name="password"]', credentials.password);
	} else if (await page.locator('input[id="password"]').count()) {
		await page.fill('input[id="password"]', credentials.password);
	} else if (await page.locator('input[type="password"]').count()) {
		await page.fill('input[type="password"]', credentials.password);
	} else {
		throw new Error("Could not find login password input.");
	}

	const loginButton = page
		.locator("button, [role='button']")
		.filter({ hasText: /log in.*continue/i })
		.first();
	if (await loginButton.count()) {
		await loginButton.click();
	} else {
		await page
			.getByText(/log in.*continue/i)
			.first()
			.click();
	}
}

async function trySelectSubcourt(page: Page, subcourt: string): Promise<boolean> {
	const exactPattern = new RegExp(`^\\s*${escapeRegExp(subcourt)}\\s*$`, "i");

	// Some layouts render all court options as direct buttons.
	const directOption = page
		.locator("button, [role='button']")
		.filter({ hasText: exactPattern })
		.first();
	if (await directOption.count()) {
		try {
			await directOption.click({ timeout: 2_500 });
			await page.waitForTimeout(300);
			return true;
		} catch {
			// fall through to dropdown flow
		}
	}

	// Other layouts expose the selected court and require opening a picker.
	const pickerTrigger = page
		.locator("button, [role='button']")
		.filter({ hasText: /court\s*\d+/i })
		.first();
	if (!(await pickerTrigger.count())) {
		return false;
	}

	try {
		await pickerTrigger.click({ timeout: 2_500 });
	} catch {
		return false;
	}

	const option = page
		.locator("div[role='option'], [role='menuitem'], li, button, [role='button']")
		.filter({ hasText: exactPattern })
		.first();
	if (!(await option.count())) {
		return false;
	}

	try {
		await option.click({ timeout: 2_500 });
		await page.waitForTimeout(300);
		return true;
	} catch {
		return false;
	}
}

async function resolveRequestedTime(
	page: Page,
	targetTime: string,
	subcourts: string[],
): Promise<{
	resolvedTime: string;
	selectedSubcourt: string | null;
	availableTimes: string[];
} | null> {
	const normalizedTarget = targetTime.toLowerCase();

	if (subcourts.length === 0) {
		const availableTimes = await extractAvailableTimes(page);
		const resolvedTime =
			availableTimes.find((slot) => slot.toLowerCase() === normalizedTarget) ??
			availableTimes.find((slot) => slot.toLowerCase().includes(normalizedTarget));
		if (!resolvedTime) {
			return null;
		}
		return { resolvedTime, selectedSubcourt: null, availableTimes };
	}

	let fallbackTimes: string[] = [];
	for (const subcourt of subcourts) {
		const selected = await trySelectSubcourt(page, subcourt);
		if (!selected) {
			continue;
		}

		const availableTimes = await extractAvailableTimes(page);
		fallbackTimes = availableTimes;
		const resolvedTime =
			availableTimes.find((slot) => slot.toLowerCase() === normalizedTarget) ??
			availableTimes.find((slot) => slot.toLowerCase().includes(normalizedTarget));
		if (resolvedTime) {
			return { resolvedTime, selectedSubcourt: subcourt, availableTimes };
		}
	}

	if (fallbackTimes.length === 0) {
		fallbackTimes = await extractAvailableTimes(page);
	}
	return null;
}

async function clickCheckoutAction(page: Page): Promise<string | null> {
	const patterns = [
		/book now/i,
		/^book$/i,
		/continue to payment/i,
		/checkout/i,
		/send code/i,
		/continue/i,
		/confirm/i,
		/pay/i,
		/complete/i,
	];
	for (const pattern of patterns) {
		const locator = page
			.locator("button, [role='button'], a")
			.filter({ hasText: pattern })
			.first();
		if (!(await locator.count())) {
			continue;
		}
		try {
			await locator.click({ timeout: 4_000 });
			return pattern.toString();
		} catch {
			// try next candidate
		}
	}
	return null;
}

async function reachSmsStep(page: Page): Promise<{ reached: boolean; clicks: string[] }> {
	const clicks: string[] = [];
	for (let i = 0; i < 12; i += 1) {
		const smsInput = page
			.locator('input[id="totp"], input[name="totp"], input[autocomplete="one-time-code"]')
			.first();
		if (await smsInput.count()) {
			return { reached: true, clicks };
		}

		const clicked = await clickCheckoutAction(page);
		if (!clicked) {
			break;
		}
		clicks.push(clicked);
		await page.waitForTimeout(1_200);
	}
	return { reached: false, clicks };
}

function estimateCartCount(body: string): number | null {
	const patterns = [
		/(\d+)\s*remaining/i,
		/\bcart\b[^0-9]{0,10}(\d+)/i,
		/(\d+)\s*items?\s+in\s+cart/i,
	];
	for (const pattern of patterns) {
		const match = body.match(pattern);
		if (match?.[1]) {
			const value = Number.parseInt(match[1], 10);
			if (!Number.isNaN(value)) {
				return value;
			}
		}
	}
	return null;
}

async function getVisibleActionLabels(page: Page): Promise<string[]> {
	return Array.from(
		new Set(
			(await page.locator("button, [role='button'], a").allTextContents())
				.map((value) => value.trim())
				.filter(Boolean),
		),
	).slice(0, 35);
}

async function openCheckoutPage(
	page: Page,
	credentials: { email: string; password: string },
): Promise<void> {
	await page.goto(REC_BASE_URL, {
		timeout: 25_000,
		waitUntil: "domcontentloaded",
	});
	await fillLoginForm(page, credentials);
	await page.waitForTimeout(2_500);
	await page.goto("https://www.rec.us/cart/checkout", {
		timeout: 25_000,
		waitUntil: "domcontentloaded",
	});
	await page.waitForTimeout(1_200);
}

async function buildCheckoutStatusText(
	page: Page,
	clicks: string[] = [],
	screenshotPath: string | null = null,
): Promise<string> {
	const body = (await page.textContent("body")) ?? "";
	const actions = await getVisibleActionLabels(page);
	const heading = (
		await page
			.locator("h1, h2, h3")
			.allTextContents()
			.catch(() => [])
	)
		.map((value) => value.trim())
		.filter(Boolean)
		.slice(0, 10);

	const cartCount = estimateCartCount(body);
	const hasSmsInput = await page
		.locator('input[id="totp"], input[name="totp"], input[autocomplete="one-time-code"]')
		.count()
		.then((count) => count > 0)
		.catch(() => false);

	return [
		`Checkout URL: ${page.url()}`,
		`Cart items (estimated): ${cartCount ?? "unknown"}`,
		`Has "Continue to Payment": ${actions.some((action) => /continue to payment/i.test(action))}`,
		`Has "Send Code": ${/send code/i.test(body)}`,
		`Has SMS input: ${hasSmsInput}`,
		`Recent checkout clicks: ${clicks.length > 0 ? clicks.join(" -> ") : "none"}`,
		`Visible actions: ${actions.length > 0 ? actions.join(", ") : "none"}`,
		`Headings: ${heading.length > 0 ? heading.join(", ") : "none"}`,
		screenshotPath ? `Screenshot: ${screenshotPath}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

async function openCourtPage(page: Page, court: string): Promise<void> {
	await page.goto(REC_BASE_URL, { timeout: 25_000, waitUntil: "domcontentloaded" });
	await page.waitForSelector(`text=${court}`, { timeout: 15_000 });
	await page.getByText(court).first().click();
	await page.waitForSelector("text=Court Reservations", { timeout: 12_000 });
}

async function selectDate(page: Page, isoDate: string): Promise<void> {
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

async function extractAvailableTimes(page: Page): Promise<string[]> {
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
			.map((line) => line.trim())
			.filter((line) => /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/i.test(line))
			.map((line) => line.toUpperCase());

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

async function pickDurationAndParticipant(page: Page): Promise<void> {
	try {
		await page.locator("xpath=//label[text()='Duration']/following-sibling::button").click();
		await page.waitForSelector("div[role='option']", { timeout: 5_000 });
		await page.locator("div[role='option']:not([aria-disabled='true'])").first().click();
	} catch {
		// Keep default duration when picker varies.
	}

	try {
		await page.getByText("Select participant").click();
		await page.getByText("Account Owner").click();
	} catch {
		// Participant picker is not always required.
	}
}

function getCredentials(): { email: string; password: string } | null {
	const email = process.env.REC_EMAIL?.trim();
	const password = process.env.REC_PASSWORD?.trim();
	if (!email || !password) {
		return null;
	}
	return { email, password };
}

function summarizeAvailability(
	court: string,
	date: string,
	availableTimes: string[],
	requestedTime?: string,
): string {
	if (availableTimes.length === 0) {
		return `No free tennis slots found at ${court} on ${date}.`;
	}

	const lines = [
		`${court} has ${availableTimes.length} slot(s) on ${date}.`,
		`Available: ${availableTimes.join(", ")}.`,
	];

	if (requestedTime) {
		const requestedAvailable = availableTimes.some((slot) =>
			slot.toLowerCase().includes(requestedTime.toLowerCase()),
		);
		lines.push(
			requestedAvailable
				? `Requested time ${requestedTime} is available.`
				: `Requested time ${requestedTime} is not available.`,
		);
	}

	return lines.join(" ");
}

async function main(): Promise<void> {
	await loadDevVars();

	const server = new McpServer({
		name: "Tennis Court Booking (Local Browser Fallback)",
		version: "1.0.0",
	});

	server.tool(
		"check_tennis_courts",
		{
			date: z
				.string()
				.optional()
				.describe("Date in YYYY-MM-DD format, 'today', 'tomorrow', or empty."),
			court: z.string().optional().describe("Court name (for example: Potrero Hill)."),
			time: z.string().optional().describe("Preferred time (for example: 1:00 PM)."),
		},
		async ({ date, court, time }) =>
			withLock(async () => {
				const targetCourt = (court ?? DEFAULT_COURT).trim();
				const targetDate = toIsoDate(date);
				const requestedTime = time ? normalizeTimeInput(time) : undefined;
				const page = await newPageWithRecovery();
				try {
					await openCourtPage(page, targetCourt);
					await selectDate(page, targetDate);
					await page.waitForSelector("text=/(\\d:)|(No free)/", { timeout: 10_000 });
					const availableTimes = await extractAvailableTimes(page);
					return {
						content: [
							{
								type: "text" as const,
								text: summarizeAvailability(
									targetCourt,
									targetDate,
									availableTimes,
									requestedTime,
								),
							},
						],
					};
				} catch (error) {
					const screenshot = await captureFailureScreenshot(
						page,
						`check-${targetCourt}-${targetDate}`,
					);
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Availability check failed: ${toReadableError(error)}` +
									(screenshot ? `\nScreenshot: ${screenshot}` : ""),
							},
						],
					};
				} finally {
					await page.close();
				}
			}),
	);

	server.tool(
		"book_and_request_sms",
		{
			court: z.string().describe("Court name (for example: Potrero Hill)."),
			time: z.string().describe("Time slot (for example: 12:00 PM)."),
			date: z.string().describe("Date in YYYY-MM-DD format, 'today', or 'tomorrow'."),
			subcourts: z
				.array(z.string())
				.optional()
				.describe(
					"Preferred subcourt names in order, e.g. ['Court 1', 'Court 2']. Defaults to Court 1/Court 2.",
				),
		},
		async ({ court, time, date, subcourts }) =>
			withLock(async () => {
				const credentials = getCredentials();
				if (!credentials) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"REC_EMAIL and REC_PASSWORD are not set. Add them to `.dev.vars` " +
									"or export them before starting this server.",
							},
						],
					};
				}

				const targetCourt = court.trim();
				const targetTime = normalizeTimeInput(time);
				const targetDate = toIsoDate(date);
				const preferredSubcourts = parseSubcourtPreferences(subcourts);
				const page = await newPageWithRecovery();

				try {
					await page.goto(REC_BASE_URL, {
						timeout: 25_000,
						waitUntil: "domcontentloaded",
					});
					await fillLoginForm(page, credentials);
					await page.waitForTimeout(2_500);

					await openCourtPage(page, targetCourt);
					await selectDate(page, targetDate);
					await page.waitForSelector("text=/(\\d:)|(No free)/", { timeout: 10_000 });

					const resolved = await resolveRequestedTime(
						page,
						targetTime,
						preferredSubcourts,
					);

					if (!resolved) {
						const availableTimes = await extractAvailableTimes(page);
						await page.close();
						return {
							content: [
								{
									type: "text" as const,
									text:
										`${targetTime} is not available. Available times: ` +
										`${availableTimes.join(", ") || "none"}.`,
								},
							],
						};
					}

					const { resolvedTime, selectedSubcourt } = resolved;

					await page.getByText(resolvedTime).first().click();
					await pickDurationAndParticipant(page);

					const smsReach = await reachSmsStep(page);
					if (!smsReach.reached) {
						const screenshot = await captureFailureScreenshot(
							page,
							`booking-stuck-${targetCourt}-${targetDate}-${resolvedTime}`,
						);
						const buttonHints = Array.from(
							new Set(
								(await page.locator("button, [role='button'], a").allTextContents())
									.map((value) => value.trim())
									.filter(Boolean),
							),
						).slice(0, 30);
						await page.close();
						return {
							content: [
								{
									type: "text" as const,
									text:
										"Booking reached checkout but could not reach SMS input.\n" +
										`Actions clicked: ${smsReach.clicks.join(" -> ") || "none"}\n` +
										`Visible actions: ${buttonHints.join(", ") || "none"}\n` +
										(screenshot ? `Screenshot: ${screenshot}` : ""),
								},
							],
						};
					}

					activeVerificationPage = page;
					pendingBooking = {
						court: targetCourt,
						time: resolvedTime,
						date: targetDate,
						timestamp: Date.now(),
					};

					return {
						content: [
							{
								type: "text" as const,
								text:
									`SMS code requested.\n\nCourt: ${targetCourt}\nTime: ${resolvedTime}\nDate: ${targetDate}\n\n` +
									`Subcourt: ${selectedSubcourt ?? "current selection"}\n\n` +
									`When your SMS code arrives, run:\n` +
									`enter_sms_code_and_complete({"code":"YOUR_SMS_CODE"})`,
							},
						],
					};
				} catch (error) {
					const screenshot = await captureFailureScreenshot(
						page,
						`booking-error-${targetCourt}-${targetDate}-${targetTime}`,
					);
					await page.close();
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Booking failed: ${toReadableError(error)}` +
									(screenshot ? `\nScreenshot: ${screenshot}` : ""),
							},
						],
					};
				}
			}),
	);

	server.tool(
		"check_checkout_status",
		{
			capture_screenshot: z
				.boolean()
				.optional()
				.describe("Capture checkout screenshot for debugging (default true)."),
		},
		async ({ capture_screenshot = true }) =>
			withLock(async () => {
				const credentials = getCredentials();
				if (!credentials) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"REC_EMAIL and REC_PASSWORD are not set. Add them to `.dev.vars` " +
									"or export them before starting this server.",
							},
						],
					};
				}

				const page = await newPageWithRecovery();
				try {
					await openCheckoutPage(page, credentials);
					const screenshot =
						capture_screenshot && CAPTURE_SCREENSHOTS
							? await captureFailureScreenshot(page, "checkout-status")
							: null;
					return {
						content: [
							{
								type: "text" as const,
								text: await buildCheckoutStatusText(page, [], screenshot),
							},
						],
					};
				} catch (error) {
					const screenshot = await captureFailureScreenshot(
						page,
						"checkout-status-error",
					);
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Checkout status check failed: ${toReadableError(error)}` +
									(screenshot ? `\nScreenshot: ${screenshot}` : ""),
							},
						],
					};
				} finally {
					await page.close();
				}
			}),
	);

	server.tool(
		"continue_checkout_to_sms",
		{
			capture_screenshot: z
				.boolean()
				.optional()
				.describe("Capture screenshot if flow cannot reach SMS input (default true)."),
		},
		async ({ capture_screenshot = true }) =>
			withLock(async () => {
				const credentials = getCredentials();
				if (!credentials) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"REC_EMAIL and REC_PASSWORD are not set. Add them to `.dev.vars` " +
									"or export them before starting this server.",
							},
						],
					};
				}

				const page = await newPageWithRecovery();
				try {
					await openCheckoutPage(page, credentials);
					const smsReach = await reachSmsStep(page);
					if (!smsReach.reached) {
						const screenshot =
							capture_screenshot && CAPTURE_SCREENSHOTS
								? await captureFailureScreenshot(page, "checkout-to-sms-stuck")
								: null;
						const statusText = await buildCheckoutStatusText(
							page,
							smsReach.clicks,
							screenshot,
						);
						await page.close();
						return {
							content: [
								{
									type: "text" as const,
									text: statusText,
								},
							],
						};
					}

					activeVerificationPage = page;
					const screenshot =
						capture_screenshot && CAPTURE_SCREENSHOTS
							? await captureFailureScreenshot(page, "checkout-sms-ready")
							: null;
					return {
						content: [
							{
								type: "text" as const,
								text:
									"Reached SMS verification input from checkout cart.\n" +
									`Checkout clicks: ${smsReach.clicks.join(" -> ") || "none"}\n` +
									'Now run: enter_sms_code_and_complete({"code":"YOUR_SMS_CODE"})\n' +
									(screenshot ? `Screenshot: ${screenshot}` : ""),
							},
						],
					};
				} catch (error) {
					const screenshot = await captureFailureScreenshot(
						page,
						"checkout-to-sms-error",
					);
					await page.close();
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Continue checkout failed: ${toReadableError(error)}` +
									(screenshot ? `\nScreenshot: ${screenshot}` : ""),
							},
						],
					};
				}
			}),
	);

	server.tool(
		"enter_sms_code_and_complete",
		{
			code: z.string().describe("SMS verification code from your phone."),
		},
		async ({ code }) =>
			withLock(async () => {
				const page = activeVerificationPage;
				if (!page || page.isClosed()) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									"No active SMS verification page found. Run `book_and_request_sms` first " +
									"and wait for the SMS input.",
							},
						],
					};
				}

				try {
					const smsInput = page
						.locator(
							'input[id="totp"], input[name="totp"], input[autocomplete="one-time-code"]',
						)
						.first();
					if (!(await smsInput.count())) {
						throw new Error("SMS code input is not visible on the current page.");
					}
					await smsInput.fill(code.trim());
					const confirmButton = page
						.locator("button, [role='button']")
						.filter({ hasText: /confirm/i })
						.last();
					if (await confirmButton.count()) {
						await confirmButton.click();
					}
					await page.waitForSelector("text=You're all set!", { timeout: 180_000 });

					if (pendingBooking) {
						completedBookings.push({
							...pendingBooking,
							status: "completed",
							confirmedAt: Date.now(),
						});
						pendingBooking = null;
					}

					await page.close();
					activeVerificationPage = null;

					return {
						content: [
							{
								type: "text" as const,
								text: 'Booking completed. rec.us returned "You\'re all set!".',
							},
						],
					};
				} catch (error) {
					const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
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
					const screenshot = await captureFailureScreenshot(page, "sms-confirm-failed");
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Failed to submit SMS code: ${toReadableError(error)}` +
									(screenshot ? `\nScreenshot: ${screenshot}` : ""),
							},
						],
					};
				}
			}),
	);

	server.tool("test_browser", {}, async () =>
		withLock(async () => {
			const page = await newPageWithRecovery();
			try {
				await page.goto("https://example.com", { timeout: 15_000 });
				const title = await page.title();
				return {
					content: [
						{
							type: "text" as const,
							text: `Local browser is healthy. Title: "${title}".`,
						},
					],
				};
			} finally {
				await page.close();
			}
		}),
	);

	server.tool(
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
			const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
			const recent = completedBookings
				.filter((booking) => booking.confirmedAt >= cutoff)
				.sort((a, b) => b.confirmedAt - a.confirmedAt)
				.slice(0, limit);

			if (recent.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No completed bookings found in the last ${days} days.`,
						},
					],
				};
			}

			const lines = recent.map(
				(booking) =>
					`- ${booking.date} | ${booking.court} | ${booking.time} | confirmed ${new Date(booking.confirmedAt).toISOString()}`,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${recent.length} booking(s) in the last ${days} days:\n${lines.join("\n")}`,
					},
				],
			};
		},
	);

	server.tool("auth_status", {}, async () => {
		const credentials = getCredentials();
		const subcourts = parseSubcourtPreferences();
		return {
			content: [
				{
					type: "text" as const,
					text:
						"Auth mode: authless (local browser fallback)\n" +
						`REC_EMAIL set: ${Boolean(credentials?.email)}\n` +
						`REC_PASSWORD set: ${Boolean(credentials?.password)}\n` +
						`Browser session connected: ${Boolean(browser?.isConnected())}\n` +
						`Headless mode: ${LOCAL_HEADLESS}\n` +
						`Failure screenshots: ${CAPTURE_SCREENSHOTS ? SCREENSHOT_DIR : "disabled"}\n` +
						`Subcourt preferences: ${subcourts.join(" -> ")}`,
				},
			],
		};
	});

	server.tool("get_auth_url", {}, async () => ({
		content: [
			{
				type: "text" as const,
				text:
					"This server is authless. There is no external auth URL. " +
					"It logs in to rec.us using REC_EMAIL and REC_PASSWORD.",
			},
		],
	}));

	const transport = new StdioServerTransport();
	await server.connect(transport);

	const shutdown = async () => {
		try {
			await activeVerificationPage?.close();
		} catch {
			// ignore
		}
		activeVerificationPage = null;

		try {
			await browser?.close();
		} catch {
			// ignore
		}
		browser = null;
	};

	process.on("SIGINT", () => {
		void shutdown().finally(() => process.exit(0));
	});
	process.on("SIGTERM", () => {
		void shutdown().finally(() => process.exit(0));
	});
}

void main().catch((error) => {
	// For stdio servers, log to stderr only.
	console.error(error);
	process.exit(1);
});
