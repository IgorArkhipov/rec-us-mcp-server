import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium, type Browser, type Page } from "playwright";

const REC_BASE_URL = "https://www.rec.us/sfrecpark";
const COURT = process.env.AUTO_BOOK_COURT?.trim() || "Potrero Hill";
const DEFAULT_SUBCOURTS = ["Court 1", "Court 2"];
const SUBCOURTS = parseSubcourtPreferences(process.env.AUTO_BOOK_SUBCOURTS);
const START_SEARCH_HOUR = 7;
const SLOT_RANGE_START_MINUTES = 7 * 60 + 30; // 7:30 AM
const SLOT_RANGE_END_MINUTES = 12 * 60; // 12:00 PM
const POLL_INTERVAL_MS = Number.parseInt(process.env.AUTO_BOOK_POLL_MS ?? "60000", 10);
const MAX_ATTEMPTS = Number.parseInt(process.env.AUTO_BOOK_MAX_ATTEMPTS ?? "90", 10);
const HEADED_MODE = process.env.AUTO_BOOK_HEADED !== "false";
const SKIP_WAIT = process.env.AUTO_BOOK_SKIP_WAIT === "true";
const SCREENSHOT_DIR = path.resolve(process.cwd(), "artifacts", "screenshots");

type Credentials = { email: string; password: string };

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
		// Optional file.
	}
}

function getCredentials(): Credentials {
	const email = process.env.REC_EMAIL?.trim();
	const password = process.env.REC_PASSWORD?.trim();
	if (!email || !password) {
		throw new Error("REC_EMAIL and REC_PASSWORD must be set in .dev.vars or environment.");
	}
	return { email, password };
}

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function getClosestSunday(base: Date): Date {
	const date = new Date(base);
	date.setHours(0, 0, 0, 0);
	const day = date.getDay();
	const delta = day === 0 ? 0 : 7 - day;
	date.setDate(date.getDate() + delta);
	return date;
}

function normalizeTimeLabel(raw: string): string {
	return raw.trim().toUpperCase();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSubcourtPreferences(raw?: string): string[] {
	if (!raw || raw.trim().length === 0) {
		return [...DEFAULT_SUBCOURTS];
	}
	return Array.from(
		new Set(
			raw
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	);
}

function timeLabelToMinutes(raw: string): number | null {
	const normalized = normalizeTimeLabel(raw);
	const match = normalized.match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/);
	if (!match) {
		return null;
	}
	let hour = Number.parseInt(match[1], 10);
	const minute = Number.parseInt(match[2], 10);
	const suffix = match[3];
	if (suffix === "PM" && hour < 12) {
		hour += 12;
	}
	if (suffix === "AM" && hour === 12) {
		hour = 0;
	}
	return hour * 60 + minute;
}

function sanitizePathPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
}

async function saveScreenshot(page: Page, label: string): Promise<string | null> {
	try {
		await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `${sanitizePathPart(label)}-${timestamp}.png`;
		const filepath = path.join(SCREENSHOT_DIR, filename);
		await page.screenshot({ path: filepath, fullPage: true });
		return filepath;
	} catch {
		return null;
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilSearchWindow(): Promise<void> {
	if (SKIP_WAIT) {
		console.log("[auto-book] AUTO_BOOK_SKIP_WAIT=true, skipping 07:00 wait.");
		return;
	}

	const now = new Date();
	const todayStart = new Date(now);
	todayStart.setHours(START_SEARCH_HOUR, 0, 0, 0);
	if (now >= todayStart) {
		console.log(`[auto-book] It is after ${START_SEARCH_HOUR}:00. Starting checks now.`);
		return;
	}
	const waitMs = todayStart.getTime() - now.getTime();
	console.log(
		`[auto-book] Waiting until ${todayStart.toLocaleString()} (${Math.round(waitMs / 1000)}s).`,
	);
	await sleep(waitMs);
}

async function ensureLoggedIn(page: Page, credentials: Credentials): Promise<void> {
	await page.goto(REC_BASE_URL, { waitUntil: "domcontentloaded", timeout: 35_000 });
	await page.waitForSelector("text=Log In", { timeout: 20_000 });
	await page.getByText("Log In").first().click();

	await page.waitForSelector('input[name="email"], input[id="email"]', { timeout: 20_000 });
	if (await page.locator('input[name="email"]').count()) {
		await page.fill('input[name="email"]', credentials.email);
	} else {
		await page.fill('input[id="email"]', credentials.email);
	}

	if (await page.locator('input[name="password"]').count()) {
		await page.fill('input[name="password"]', credentials.password);
	} else if (await page.locator('input[id="password"]').count()) {
		await page.fill('input[id="password"]', credentials.password);
	} else {
		await page.fill('input[type="password"]', credentials.password);
	}

	const loginButton = page
		.locator("button, [role='button']")
		.filter({ hasText: /log in.*continue/i })
		.first();
	await loginButton.click();
	await page.waitForTimeout(2_500);
}

async function openCourt(page: Page, court: string): Promise<void> {
	await page.waitForSelector(`text=${court}`, { timeout: 20_000 });
	await page.getByText(court).first().click();
	await page.waitForSelector("text=Court Reservations", { timeout: 15_000 });
}

async function selectDate(page: Page, dateIso: string): Promise<void> {
	const targetDate = new Date(`${dateIso}T00:00:00`);
	const today = new Date();
	const monthDiff =
		(targetDate.getFullYear() - today.getFullYear()) * 12 +
		(targetDate.getMonth() - today.getMonth());

	await page.locator("input").first().click();
	await page.waitForSelector(".react-datepicker", { timeout: 10_000 });

	if (monthDiff > 0) {
		for (let i = 0; i < monthDiff; i += 1) {
			await page.getByRole("button", { name: /right|next/i }).click();
		}
	} else if (monthDiff < 0) {
		for (let i = 0; i < Math.abs(monthDiff); i += 1) {
			await page.getByRole("button", { name: /left|prev/i }).click();
		}
	}

	const day = targetDate.getDate();
	const daySelector = `.react-datepicker__day--0${day < 10 ? "0" : ""}${day}:not(.react-datepicker__day--outside-month)`;
	await page.locator(daySelector).first().click();
}

async function extractTimes(page: Page): Promise<string[]> {
	await page.waitForSelector("text=/(\\d:)|(No free)/", { timeout: 15_000 });
	try {
		const raw = await page
			.getByText("Tennis")
			.first()
			.evaluate(
				(element: { parentElement: { innerText?: string | undefined } | null }) =>
					element.parentElement?.innerText ?? "",
			);
		const parsed = raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/i.test(line))
			.map((line) => normalizeTimeLabel(line));
		if (parsed.length > 0) {
			return Array.from(new Set(parsed));
		}
	} catch {
		// fallback
	}

	const body = (await page.textContent("body")) ?? "";
	const matches = body.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)\b/gi) ?? [];
	return Array.from(new Set(matches.map((value) => normalizeTimeLabel(value))));
}

async function trySelectSubcourt(page: Page, subcourt: string): Promise<boolean> {
	const exactPattern = new RegExp(`^\\s*${escapeRegExp(subcourt)}\\s*$`, "i");
	const directOption = page
		.locator("button, [role='button']")
		.filter({ hasText: exactPattern })
		.first();
	if (await directOption.count()) {
		try {
			await directOption.click({ timeout: 2_500 });
			await page.waitForTimeout(250);
			return true;
		} catch {
			// fall through to picker flow
		}
	}

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
		await page.waitForTimeout(250);
		return true;
	} catch {
		return false;
	}
}

async function findBestSlotAcrossSubcourts(
	page: Page,
	subcourts: string[],
): Promise<{
	slot: string | null;
	selectedSubcourt: string | null;
	observedTimes: string[];
}> {
	let best:
		| {
				slot: string;
				selectedSubcourt: string | null;
				minutes: number;
				observedTimes: string[];
		  }
		| undefined;
	let observedAll: string[] = [];

	const candidates = subcourts.length > 0 ? subcourts : [""];
	for (const subcourt of candidates) {
		if (subcourt) {
			const selected = await trySelectSubcourt(page, subcourt);
			if (!selected) {
				continue;
			}
		}

		const times = await extractTimes(page);
		observedAll = Array.from(new Set([...observedAll, ...times]));
		const slot = pickEarliestInWindow(times);
		if (!slot) {
			continue;
		}
		const minutes = timeLabelToMinutes(slot);
		if (minutes === null) {
			continue;
		}

		if (!best || minutes < best.minutes) {
			best = {
				slot,
				selectedSubcourt: subcourt || null,
				minutes,
				observedTimes: times,
			};
		}
	}

	if (!best) {
		return { slot: null, selectedSubcourt: null, observedTimes: observedAll };
	}
	return {
		slot: best.slot,
		selectedSubcourt: best.selectedSubcourt,
		observedTimes: best.observedTimes,
	};
}

function pickEarliestInWindow(allTimes: string[]): string | null {
	const candidates = allTimes
		.map((label) => ({ label, minutes: timeLabelToMinutes(label) }))
		.filter((entry): entry is { label: string; minutes: number } => entry.minutes !== null)
		.filter(
			(entry) =>
				entry.minutes >= SLOT_RANGE_START_MINUTES &&
				entry.minutes <= SLOT_RANGE_END_MINUTES,
		)
		.sort((a, b) => a.minutes - b.minutes);
	return candidates[0]?.label ?? null;
}

async function pickDurationAndParticipant(page: Page): Promise<void> {
	try {
		await page.locator("xpath=//label[text()='Duration']/following-sibling::button").click({
			timeout: 3_000,
		});
		await page.locator("div[role='option']:not([aria-disabled='true'])").first().click({
			timeout: 3_000,
		});
	} catch {
		// optional
	}

	try {
		await page.getByText("Select participant").first().click({ timeout: 3_000 });
		const accountOwner = page.getByText(/Account Owner/i).first();
		if (await accountOwner.count()) {
			await accountOwner.click({ timeout: 3_000 });
		}
	} catch {
		// optional
	}
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
		const action = page
			.locator("button, [role='button'], a")
			.filter({ hasText: pattern })
			.first();
		if (!(await action.count())) {
			continue;
		}
		try {
			await action.click({ timeout: 4_000 });
			return pattern.toString();
		} catch {
			// keep trying other actions
		}
	}
	return null;
}

async function reachSmsInput(page: Page): Promise<{ reached: boolean; clicks: string[] }> {
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

async function promptForSmsCode(): Promise<string | null> {
	const rl = readline.createInterface({ input, output });
	try {
		const value = (
			await rl.question(
				"[auto-book] Enter SMS code to finish booking (or press Enter to skip): ",
			)
		).trim();
		return value.length > 0 ? value : null;
	} finally {
		rl.close();
	}
}

async function completeWithSmsCode(page: Page, code: string): Promise<boolean> {
	const smsInput = page
		.locator('input[id="totp"], input[name="totp"], input[autocomplete="one-time-code"]')
		.first();
	if (!(await smsInput.count())) {
		return false;
	}
	await smsInput.fill(code);
	const confirm = page
		.locator("button, [role='button']")
		.filter({ hasText: /confirm/i })
		.last();
	if (await confirm.count()) {
		await confirm.click();
	}
	await page.waitForSelector("text=You're all set!", { timeout: 180_000 });
	return true;
}

async function runBookingAttempt(
	page: Page,
	credentials: Credentials,
	targetDateIso: string,
): Promise<{
	status: "booked" | "sms_ready" | "no_slot" | "stuck";
	slot?: string;
	selectedSubcourt?: string | null;
	clicks?: string[];
	screenshot?: string | null;
	availableTimes?: string[];
}> {
	await ensureLoggedIn(page, credentials);
	await openCourt(page, COURT);
	await selectDate(page, targetDateIso);
	const slotSearch = await findBestSlotAcrossSubcourts(page, SUBCOURTS);
	const slot = slotSearch.slot;
	if (!slot) {
		return { status: "no_slot", availableTimes: slotSearch.observedTimes };
	}

	if (slotSearch.selectedSubcourt) {
		await trySelectSubcourt(page, slotSearch.selectedSubcourt);
	}
	await page.getByText(slot).first().click();
	await pickDurationAndParticipant(page);
	const sms = await reachSmsInput(page);
	if (!sms.reached) {
		const screenshot = await saveScreenshot(page, "auto-book-stuck");
		return {
			status: "stuck",
			slot,
			selectedSubcourt: slotSearch.selectedSubcourt,
			clicks: sms.clicks,
			screenshot,
		};
	}

	const screenshot = await saveScreenshot(page, "auto-book-sms-ready");
	return {
		status: "sms_ready",
		slot,
		selectedSubcourt: slotSearch.selectedSubcourt,
		screenshot,
	};
}

async function main(): Promise<void> {
	await loadDevVars();
	const credentials = getCredentials();
	await waitUntilSearchWindow();

	const targetSunday = getClosestSunday(new Date());
	const targetDateIso = formatLocalDate(targetSunday);
	console.log(
		`[auto-book] Target court: ${COURT}. Subcourt preferences: ${SUBCOURTS.join(" -> ")}. ` +
			`Searching for first slot between 07:30 and 12:00 on ${targetDateIso}.`,
	);

	let browser: Browser | null = null;
	try {
		browser = await chromium.launch({
			headless: !HEADED_MODE,
			args: HEADED_MODE ? ["--start-maximized"] : [],
		});

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			const page = await browser.newPage(
				HEADED_MODE ? { viewport: null } : { viewport: { width: 1920, height: 1080 } },
			);
			page.setDefaultTimeout(25_000);
			try {
				console.log(`[auto-book] Attempt ${attempt}/${MAX_ATTEMPTS}`);
				const result = await runBookingAttempt(page, credentials, targetDateIso);

				if (result.status === "no_slot") {
					console.log(
						`[auto-book] No slot in range yet. Available: ${result.availableTimes?.join(", ") || "none"}`,
					);
				} else if (result.status === "stuck") {
					console.log(
						`[auto-book] Reached checkout but could not reach SMS input for ${result.slot}` +
							`${result.selectedSubcourt ? ` (${result.selectedSubcourt})` : ""}.`,
					);
					console.log(
						`[auto-book] Checkout clicks: ${result.clicks?.join(" -> ") || "none"}`,
					);
					if (result.screenshot) {
						console.log(`[auto-book] Screenshot: ${result.screenshot}`);
					}
					// Keep retrying in case checkout state changes.
				} else if (result.status === "sms_ready") {
					console.log(
						`[auto-book] SMS step reached for ${result.slot}` +
							`${result.selectedSubcourt ? ` (${result.selectedSubcourt})` : ""}.`,
					);
					if (result.screenshot) {
						console.log(`[auto-book] Screenshot: ${result.screenshot}`);
					}
					const code = await promptForSmsCode();
					if (!code) {
						console.log(
							"[auto-book] SMS code skipped. Booking remains pending at SMS step.",
						);
						return;
					}
					await completeWithSmsCode(page, code);
					const doneShot = await saveScreenshot(page, "auto-book-complete");
					console.log("[auto-book] Booking completed successfully.");
					if (doneShot) {
						console.log(`[auto-book] Screenshot: ${doneShot}`);
					}
					return;
				}
			} catch (error) {
				console.error(
					`[auto-book] Attempt failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				const screenshot = await saveScreenshot(page, "auto-book-error");
				if (screenshot) {
					console.error(`[auto-book] Screenshot: ${screenshot}`);
				}
			} finally {
				await page.close().catch(() => {});
			}

			if (attempt < MAX_ATTEMPTS) {
				await sleep(POLL_INTERVAL_MS);
			}
		}

		console.log("[auto-book] Stopped after max attempts without booking.");
	} finally {
		await browser?.close().catch(() => {});
	}
}

void main().catch((error) => {
	console.error(`[auto-book] Fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
