import * as puppeteer from "puppeteer";
import {Context, WebRegLoginResult} from "./types";

export const SMS = "sms";
export const PUSH = "push";

export const NUM_ATTEMPTS_BEFORE_EXIT: number = 6;
const WEBREG_URL: string = "https://act.ucsd.edu/webreg2/start";

/**
 * Prints a help message explaining how the program works.
 */
export function printHelpMessage(): void {
    console.log("webreg automatic login script: automatically get updated session cookies for webreg.");
    console.log("usage 1: for any term.")
    console.log("\tusage: node index.js --port <port> [--debug]");
    console.log("\t\twhere <port> is an integer.");
    console.log("\t\twhere --debug is used if you want to enable debug mode");
    console.log("\texample: node index.js 3000");

    console.log("usage 2: for a specific term.");
    console.log("\tusage: node index.js --port <port> [--term <term>] [--debug]");
    console.log(`\t\twhere <term> starts with a term (e.g., SP, WI) and ends with the year (e.g., 24, 21).`);
    console.log("\t\twhere <port> is an integer.");
    console.log("\t\twhere --debug is used if you want to enable debug mode");
    console.log("\texample: node index.js SP22 3000");
}

export const TERM_ARR: { [term: string]: [number, number] } = {
    "SP": [5200, 22], // SP22
    "S1": [5210, 22], // S122
    "S2": [5220, 22], // S222
    "S3": [5230, 22], // S322
    "SU": [5240, 22], // SU22
    "FA": [5250, 22], // FA22
    "WI": [5260, 23], // WI23
};

/**
 * Gets the sequence ID associated with the specified term.
 * @param termYear The term.
 * @return The sequence ID, or `0` if the term passed in is invalid.
 */
export function getTermSeqId(termYear: string): number {
    if (termYear.length !== 4) {
        return 0;
    }

    const term = termYear.substring(0, 2);
    if (!(term in TERM_ARR)) {
        return 0;
    }

    const [baseSeqId, baseYear] = TERM_ARR[term];

    const year = Number.parseInt(termYear.substring(2), 10);
    if (Number.isNaN(year)) {
        return 0;
    }

    return 70 * (year - baseYear) + baseSeqId;
}

/**
 * Logs a message.
 * @param term The term to display this log with.
 * @param msg The message to log.
 */
export function logNice(term: string, msg: string): void {
    const time = new Intl.DateTimeFormat([], {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
    }).format(new Date());
    console.info(`[${time}] [${term}] ${msg}`);
}

/**
 * Waits a certain number of milliseconds before continuing execution.
 * @param ms The number of milliseconds to wait.
 */
export function waitFor(ms: number): Promise<void> {
    return new Promise(async r => {
        setTimeout(() => {
            r();
        }, ms);
    });
}

/**
 * Gets new WebReg session cookies. This assumes that
 * - your WebReg credentials are correct, and
 * - Duo Push is automatically activated upon reaching the Duo 2FA page.
 *
 * Note that calling this function does take some time to finish, upwards of 30
 * seconds in some cases.
 *
 * @returns One of
 * - your cookie string, if available.
 * - an empty string, if an issue occurred when attempting to either authenticate
 * with Duo 2FA (e.g., could not load the 2FA page) or when trying to access WebReg
 * in general.
 * - `"ERROR UNABLE TO AUTHENTICATE."`, if the script is unable to log into WebReg
 * after a certain number of tries.
 */
export async function fetchCookies(ctx: Context, browser: puppeteer.Browser, isInit: boolean): Promise<string> {
    const termLog = ctx.termInfo?.termName ?? "ALL";
    logNice(termLog, "GetCookies function called.");

    let numFailedAttempts = 0;
    while (true) {
        // Close any unnecessary pages.
        let pages = await browser.pages();
        while (pages.length > 1) {
            await pages.at(-1)!.close();
            pages = await browser.pages();
        }

        const page = await browser.newPage();
        try {
            logNice(termLog, "Opened new page. Attempting to connect to WebReg site.")
            const resp = await page.goto(WEBREG_URL);
            // If we somehow cannot reach the page, try again.
            if (!resp) {
                numFailedAttempts++;
                logNice(termLog, `Unable to open page. Retrying (${numFailedAttempts}/${NUM_ATTEMPTS_BEFORE_EXIT}).`);
                continue;
            }

            logNice(termLog, `Reached ${resp.url()} with status code ${resp.status()}.`);
            if (resp.status() < 200 || resp.status() >= 300) {
                throw new Error("Non-OK Status Code Returned.");
            }
        } catch (e) {
            // Timed out probably, or failed to get page for some reason.
            logNice(termLog, "An error occurred when trying to reach WebReg. See error stack trace below.");
            console.info(e);
            console.info();
            return "";
        }

        await waitFor(3000);
        const content = await page.content();
        // This assumes that the credentials are valid.
        if (content.includes("Signing on using:") && content.includes("TritonLink user name")) {
            logNice(termLog, "Attempting to sign in to TritonLink.");
            // https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Selectors
            await page.type('#ssousername', ctx.webreg.username);
            await page.type('#ssopassword', ctx.webreg.password);
            await page.click('button[type="submit"]');
        }

        // Wait for either Duo 2FA frame (if we need 2FA) or "Go" button (if no 2FA needed) to show up
        logNice(termLog, "Waiting for Duo 2FA frame or 'Go' button to show up.");


        let loggedIn = false;
        const r: WebRegLoginResult = await Promise.race([
            // Either wait for the 'Go' button to show up, which implies that we
            // have an authenticated session, **OR** wait for the Duo frame
            // to show up.
            //
            // If an error occurred, it means the 'Go' button could not be found
            // after 30 seconds. This implies that the Duo frame could not be
            // found since *if* the Duo frame did show up, then the error would
            // have never occurred.

            // Here, we wait for the 'Go' button (to load WebReg for a term) to
            // show up.
            (async () => {
                try {
                    await page.waitForSelector("#startpage-button-go", {visible: true, timeout: 30 * 1000});
                } catch (_) {
                    // conveniently ignore the error
                    return WebRegLoginResult.UNKNOWN_ERROR;
                }

                loggedIn = true;
                return WebRegLoginResult.LOGGED_IN;
            })(),
            // Here, we *repeatedly* check to see if the Duo 2FA frame is visible AND some components of
            // the frame (in our case, the "Remember Me" checkbox) are visible.
            (async () => {
                const interval = await new Promise<NodeJS.Timeout>(r => {
                    const internalInterval = setInterval(async () => {
                        try {
                            // If we're logged in, then we can stop the interval.
                            if (loggedIn) {
                                r(internalInterval);
                                return;
                            }

                            const possDuoFrame = await page.$("iframe[id='duo_iframe']");
                            if (!possDuoFrame) {
                                return;
                            }

                            const duoFrame = await possDuoFrame.contentFrame();
                            if (!duoFrame) {
                                return;
                            }

                            if (!(await duoFrame.$("#remember_me_label_text"))) {
                                return;
                            }

                            r(internalInterval);
                        } catch (e) {
                            // Conveniently ignore the error
                        }
                    }, 500);
                });

                clearInterval(interval);
                return WebRegLoginResult.NEEDS_DUO;
            })()
        ]);

        // If we hit this, then we just try again.
        if (r === WebRegLoginResult.UNKNOWN_ERROR) {
            // If too many failed attempts, then notify the caller.
            // After all, we don't want to make too many Duo pushes and get
            // the AD account blocked by ITS :)
            if (numFailedAttempts >= NUM_ATTEMPTS_BEFORE_EXIT) {
                logNice(termLog, "Unable to authenticate due to too many attempts reached, giving up.")
                return "ERROR UNABLE TO AUTHENTICATE.";
            }

            numFailedAttempts++;
            logNice(termLog, `Unable to find a 'Go' button or Duo 2FA frame. Retrying (${numFailedAttempts}/${NUM_ATTEMPTS_BEFORE_EXIT}).`);
            continue;
        }

        logNice(
            termLog,
            r === WebRegLoginResult.LOGGED_IN
                ? "'Go' button found. No 2FA needed."
                : "Duo 2FA frame found. Ignore the initial 2FA request; i.e., do not"
                    + " accept the 2FA request until you are told to do so."
        );

        // Wait an additional 4 seconds to make sure everything loads up.
        await waitFor(4 * 1000);

        // No go button means we need to log in.
        if (r === WebRegLoginResult.NEEDS_DUO) {
            if (!isInit && ctx.loginType === PUSH) {
                logNice(termLog, "Attempting to send request to Duo, but this wasn't supposed to happen");
                throw new Error("ruby is bad");
            }

            logNice(termLog, "Beginning Duo 2FA process. Do not accept yet.");
            // Need to find a duo iframe so we can actually authenticate
            const possDuoFrame = await page.$("iframe[id='duo_iframe']");
            if (!possDuoFrame) {
                logNice(termLog, "No possible Duo frame found. Returning empty string.");
                console.info();
                throw new Error();
            }

            const duoFrame = await possDuoFrame.contentFrame();
            if (!duoFrame) {
                logNice(termLog, "Duo frame not attached. Returning empty string.");
                console.info();
                throw new Error();
            }

            if (ctx.automaticPushEnabled) {
                // it's possible that we might need to cancel our existing authentication request,
                // especially if we have duo push automatically send upon logging in
                await waitFor(1000);
                const cancelButton = await duoFrame.$(".btn-cancel");
                if (cancelButton) {
                    await cancelButton.click();
                    logNice(termLog, "Clicked the CANCEL button to cancel initial 2FA request. Do not respond to 2FA request.");
                }
            }

            await waitFor(1000);
            // Remember me for 7 days
            await duoFrame.click('#remember_me_label_text');
            logNice(termLog, "Checked the 'Remember me for 7 days' box.");
            await waitFor(1000);

            if (ctx.loginType === SMS) {
                // Click on the 'enter a passcode' button
                await duoFrame.click("#passcode");
                await waitFor(1500);
                const smsCodeHint = await duoFrame.$("#auth_methods > fieldset > div.passcode-label.row-label > div > div");
                if (!smsCodeHint) {
                    logNice(termLog, "No SMS code hint found. That might be a problem.");
                    console.info();
                    throw new Error();
                }

                const smsPasscodeHint = await smsCodeHint.evaluate(elem => elem.textContent);
                if (!smsPasscodeHint || !smsPasscodeHint.startsWith("Your next SMS Passcode starts with")) {
                    logNice(termLog, "SMS code hint element found, but no text found or bad (ruby) text found.");
                    console.info();
                    throw new Error();
                }

                logNice(termLog, `Found SMS passcode hint '${smsPasscodeHint}'`);
                const hint = smsPasscodeHint.split(" ").at(-1)!;
                const codeToUse = ctx.tokens.find(token => token.startsWith(hint));
                if (!codeToUse) {
                    logNice(termLog, `No SMS code could not be found that satisfies the hint ('${smsPasscodeHint}')`);
                    console.info();
                    throw new Error();
                }

                logNice(termLog, `Code should start with number '${hint}'. Using code '${codeToUse}'`);
                await waitFor(1500);
                // Put the SMS code into the text box
                const smsTextBox = await duoFrame.$("#auth_methods > fieldset > div.passcode-label.row-label > div > input");
                if (!smsTextBox) {
                    logNice(termLog, "Could not find the SMS text box to put your SMS token in.");
                    console.info();
                    throw new Error();
                }

                await smsTextBox.type(codeToUse.toString());
                await waitFor(1500);

                // Then, press the "Log In" button
                await duoFrame.click("#passcode");
                logNice(termLog, `Entered SMS code '${codeToUse}' and clicked the 'Log In' button.`);
                await waitFor(1500);

                try {
                    // See if we used an incorrect code.
                    // 
                    // NOTE: If we have the correct code, then the frame will no longer exist, so a try/catch
                    // is used to ensure that possibility happens.
                    const frameContent = await duoFrame.content();
                    if (frameContent.includes("Incorrect passcode. Enter a passcode from Duo Mobile or a text.")) {
                        logNice(termLog, "The passcode is incorrect. This is so sad.");
                        console.info();
                        throw new Error();
                    }
                }
                catch (_) {
                    // conveniently ignore this error, too
                }
            }
            else {
                // Send me a push
                await duoFrame.click('#auth_methods > fieldset > div.row-label.push-label > button');
                logNice(termLog, "A Duo push was sent. Please respond to the new 2FA request.");
            }
        }

        try {
            await Promise.all([
                page.waitForSelector("#startpage-select-term", {visible: true}),
                page.waitForSelector('#startpage-button-go', {visible: true})
            ]);
        } catch (e) {
            // If this hits, then somehow the Go button (for loading WebReg with that term)
            // didn't load at all. This is rare, although it does happen from time to time
            // for reasons I have yet to understand.
            //
            // Note that I used a try/catch in Promise.all instead of Promise.allSettled
            // because waitForSelector apparently throws the error instead of rejecting?
            // Not sure if there's a way to handle that without try/catch
            logNice(termLog, "Could not find select term dropdown or Go button.");
            console.info(e);
            console.info();
            return "";
        }

        logNice(termLog, "Logged into WebReg successfully.");

        let urlToFetch: string = "https://act.ucsd.edu/webreg2/svc/wradapter/get-term";
        if (ctx.termInfo) {
            const termName = ctx.termInfo.termName;
            const termSelector = `${ctx.termInfo.seqId}:::${termName}`;
            await page.select("#startpage-select-term", termSelector);
            // Get cookies ready to load.
            await page.click('#startpage-button-go');
            urlToFetch = `https://act.ucsd.edu/webreg2/svc/wradapter/secure/sched-get-schednames?termcode=${termName}`;
        }

        const cookies = await page.cookies(urlToFetch);
        logNice(termLog, `Extracted cookies for term '${termLog}' and responding back with them.\n`);

        if (ctx.session.start === 0) {
            ctx.session.start = Date.now();
        } else {
            ctx.session.callHistory.push(Date.now());
        }

        return cookies.map(x => `${x.name}=${x.value}`).join("; ");
    }
}
