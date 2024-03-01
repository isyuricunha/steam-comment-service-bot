/*
 * File: bot.js
 * Project: steam-comment-service-bot
 * Created Date: 2021-07-09 16:26:00
 * Author: 3urobeat
 *
 * Last Modified: 2024-03-01 17:59:47
 * Modified By: 3urobeat
 *
 * Copyright (c) 2021 - 2024 3urobeat <https://github.com/3urobeat>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


const SteamUser      = require("steam-user");
const SteamCommunity = require("steamcommunity");
const request        = require("request"); // Yes I know, the library is deprecated but we must wait for node-steamcommunity to drop the lib as well

const EStatus        = require("./EStatus.js");
const Controller     = require("../controller/controller.js"); // eslint-disable-line
const DataManager    = require("../dataManager/dataManager.js"); // eslint-disable-line
const SessionHandler = require("../sessions/sessionHandler.js");


/**
 * Constructor - Initializes an object which represents a user steam account
 * @class
 * @param {Controller} controller Reference to the controller object
 * @param {number} index The index of this account in the logininfo object
 */
const Bot = function(controller, index) {

    /**
     * Reference to the controller object
     * @type {Controller}
     */
    this.controller = controller;

    /**
     * Reference to the DataManager object
     * @type {DataManager}
     */
    this.data = controller.data;

    /**
     * Login index of this bot account
     * @type {number}
     */
    this.index = index;

    /**
     * Status of this bot account
     * @type {EStatus}
     */
    this.status = EStatus.OFFLINE;

    /**
     * SteamID64's to ignore in the friendMessage event handler. This is used by readChatMessage() to prevent duplicate responses.
     * @type {string[]}
     */
    this.friendMessageBlock = [];

    let proxyIndex = this.index % controller.data.proxies.length; // Spread all accounts equally with a simple modulo calculation

    /**
     * Additional login related information for this bot account
     */
    this.loginData = {
        logOnOptions:  controller.data.logininfo.find((e) => e.index == index), // TODO: This could be an issue later when the index could change at runtime
        logOnTries:    0,
        relogTries:    0, // Amount of times logOns have been retried after relogTimeout. handleRelog() attempts to cycle proxies after enough failures
        pendingLogin:  false,
        waitingFor2FA: false, // Set by sessionHandler's handle2FA helper to prevent handleLoginTimeout from triggering
        proxyIndex:    proxyIndex,
        proxy:         controller.data.proxies[proxyIndex].proxy
    };

    /**
     * Stores the timestamp and reason of the last disconnect. This is used by handleRelog() to take proper action
     */
    this.lastDisconnect = {
        timestamp: 0,
        reason: ""
    };

    // Define the log message prefix of this account in order to
    if (index == 0) this.logPrefix = "Main";
        else this.logPrefix = `Bot ${index}`;


    // Load helper files
    require("./events/debug.js");
    require("./events/disconnected.js");
    require("./events/error.js");
    require("./events/friendMessage.js");
    require("./events/loggedOn.js");
    require("./events/relationship.js");
    require("./events/webSession.js");
    require("./helpers/checkMsgBlock.js");
    require("./helpers/handleLoginTimeout.js");
    require("./helpers/handleMissingGameLicenses.js");
    require("./helpers/handleRelog.js");
    require("./helpers/steamChatInteraction.js");

    // Create sessionHandler object for this account
    this.sessionHandler = new SessionHandler(this);

    // Create user & community instance
    logger("debug", `[${this.logPrefix}] Using proxy ${this.loginData.proxyIndex} "${this.loginData.proxy}" to log in to Steam and SteamCommunity...`);

    // Force protocol for now: https://dev.doctormckay.com/topic/4187-disconnect-due-to-encryption-error-causes-relog-to-break-error-already-logged-on/?do=findComment&comment=10917
    /**
     * This SteamUser instance
     * @type {SteamUser}
     */
    this.user = new SteamUser({ autoRelogin: false, renewRefreshTokens: true, httpProxy: this.loginData.proxy, protocol: SteamUser.EConnectionProtocol.WebSocket });

    /**
     * This SteamCommunity instance
     * @type {SteamCommunity}
     */
    this.community = new SteamCommunity({ request: request.defaults({ "proxy": this.loginData.proxy }) }); // Pass proxy to community library as well

    // Load my library patches
    require("../libraryPatches/CSteamSharedFile.js");
    require("../libraryPatches/sharedfiles.js");
    require("../libraryPatches/helpers.js");
    require("../libraryPatches/CSteamDiscussion.js");
    require("../libraryPatches/discussions.js");
    require("../libraryPatches/CSteamReviews.js");
    require("../libraryPatches/reviews.js");

    if (global.checkm8!="b754jfJNgZWGnzogvl<rsHGTR4e368essegs9<") this.controller.stop(); // eslint-disable-line


    // Attach all SteamUser event listeners we need
    this._attachSteamDebugEvent();
    this._attachSteamDisconnectedEvent();
    this._attachSteamErrorEvent();
    this._attachSteamFriendMessageEvent();
    this._attachSteamLoggedOnEvent();
    this._attachSteamFriendRelationshipEvent();
    this._attachSteamGroupRelationshipEvent();
    this._attachSteamWebSessionEvent();

    this.user.on("refreshToken", (newToken) => { // Emitted when refreshToken is auto-renewed by SteamUser
        logger("info", `[${this.logPrefix}] SteamUser auto renewed this refresh token, updating database entry...`);
        this.sessionHandler._saveTokenToStorage(newToken);
    });


    // Get new websession as sometimes the this.user would relog after a lost connection but wouldn't get a websession. Read more about cookies & expiration: https://dev.doctormckay.com/topic/365-cookies/
    let lastWebSessionRefresh = Date.now(); // Track when the last refresh was to avoid spamming webLogOn() on sessionExpired

    this.community.on("sessionExpired", () => {
        if (Date.now() - lastWebSessionRefresh < 15000) return; // Last refresh was 15 seconds ago so ignore this call

        logger("info", `[${this.logPrefix}] Session seems to be expired. Trying to get new websession...`);
        lastWebSessionRefresh = Date.now(); // Update time
        this.user.webLogOn();
    });

};


/**
 * Status which a bot object can have
 * @enum {EStatus}
 */
Bot.EStatus = EStatus;


/**
 * Calls SteamUser logOn() for this account. This will either trigger the SteamUser loggedOn or error event.
 */
Bot.prototype._loginToSteam = async function() {

    // Cancel if account is already trying to log on and deny this duplicate request
    if (this.loginData.pendingLogin) return logger("debug", `[${this.logPrefix}] Login requested but there is already a login process active. Ignoring...`);

    // Ignore login attempt if logOnTries are exeeded or if account is currently ONLINE
    if (this.status == EStatus.ONLINE || this.loginData.logOnTries > this.controller.data.advancedconfig.maxLogOnRetries) {
        logger("debug", `[${this.logPrefix}] Login requested but account ${this.status == EStatus.ONLINE ? "is ONLINE" : "has exceeded maxLogOnRetries"}. Ignoring...`);
        return;
    }

    this.loginData.pendingLogin = true; // Register this attempt and block any further requests

    // Count this attempt
    this.loginData.logOnTries++;

    // Always call logOff() before logOn() like an idiot to prevent "Already attempting to log on, cannot log on again" errors
    this.user.logOff();

    if (this.sessionHandler.session) this.sessionHandler.session.cancelLoginAttempt(); // TODO: This might cause an error as idk if we are polling. Maybe use the timeout event of steam-session


    // Find proxyIndex from steam-user object options instead of loginData to get reliable log data
    let thisProxy = this.data.proxies.find((e) => e.proxy == this.user.options.httpProxy);

    // Log login message for this account, with mentioning proxies or without
    if (!thisProxy.proxy) logger("info", `[${this.logPrefix}] Trying to log in without proxy... (Attempt ${this.loginData.logOnTries}/${this.controller.data.advancedconfig.maxLogOnRetries + 1})`, false, true, logger.animation("loading"));
        else logger("info", `[${this.logPrefix}] Trying to log in with proxy ${thisProxy.proxyIndex}... (Attempt ${this.loginData.logOnTries}/${this.controller.data.advancedconfig.maxLogOnRetries + 1})`, false, true, logger.animation("loading"));

    // Attach loginTimeout handler
    this.handleLoginTimeout();


    // Call our steam-session helper to get a valid refresh token for us
    let refreshToken = await this.sessionHandler.getToken();

    if (!refreshToken) return this.loginData.pendingLogin = false; // Stop execution if getRefreshToken aborted login attempt, it either skipped this account or stopped the bot itself


    // Login with this account using the refreshToken we just obtained using steam-session
    this.user.logOn({ "refreshToken": refreshToken });

};


// Make bot accessible from outside
module.exports = Bot;


/* -------- Register functions to let the IntelliSense know what's going on in helper files -------- */

/**
 * Handles the SteamUser debug events if enabled in advancedconfig
 */
Bot.prototype._attachSteamDebugEvent = function() {};

/**
 * Handles the SteamUser disconnect event and tries to relog the account
 */
Bot.prototype._attachSteamDisconnectedEvent = function() {};

/**
 * Handles the SteamUser error event
 */
Bot.prototype._attachSteamErrorEvent = function() {};

/**
 * Handles messages, cooldowns and executes commands.
 */
Bot.prototype._attachSteamFriendMessageEvent = function() {};

/**
 * Do some stuff when account is logged in
 */
Bot.prototype._attachSteamLoggedOnEvent = function() {};

/**
 * Accepts a friend request, adds the user to the lastcomment.db database and invites him to your group
 */
Bot.prototype._attachSteamFriendRelationshipEvent = function() {};

/**
 * Accepts a group invite if acceptgroupinvites in the config is true
 */
Bot.prototype._attachSteamGroupRelationshipEvent = function() {};

/**
 * Handles setting cookies and accepting offline friend & group invites
 */
Bot.prototype._attachSteamWebSessionEvent = function() {};

/**
 * Checks if user is blocked, has an active cooldown for spamming or isn't a friend
 * @param {object} steamID64 The steamID64 of the message sender
 * @param {string} message The message string provided by steam-user friendMessage event
 * @returns {boolean} `true` if friendMessage event shouldn't be handled, `false` if user is allowed to be handled
 */
Bot.prototype.checkMsgBlock = async function(steamID64, message) {}; // eslint-disable-line

/**
 * Handles aborting a login attempt should an account get stuck to prevent the bot from softlocking (see issue #139)
 */
Bot.prototype.handleLoginTimeout = function() {};

/**
 * Handles checking for missing game licenses, requests them and then starts playing
 */
Bot.prototype.handleMissingGameLicenses = function() {};

/**
 * Changes the proxy of this bot account and relogs it.
 * @param {number} newProxyIndex Index of the new proxy inside the DataManager.proxies array.
 */
Bot.prototype.switchProxy = function(newProxyIndex) {}; // eslint-disable-line

/**
 * Checks host internet connection, updates the status of all proxies checked >2.5 min ago and switches the proxy of this bot account if necessary.
 * @returns {Promise.<boolean>} Resolves with a boolean indicating whether the proxy was switched when done. A relog is triggered when the proxy was switched.
 */
Bot.prototype.checkAndSwitchMyProxy = async function() {};

/**
 * Attempts to get this account, after failing all logOnRetries, back online after some time. Does not apply to initial logins.
 */
Bot.prototype.handleRelog = function() {};

/**
 * Our commandHandler respondModule implementation - Sends a message to a Steam user
 * @param {object} _this The Bot object context
 * @param {import("../commands/commandHandler.js").resInfo} resInfo Object containing information passed to command by friendMessage event
 * @param {string} txt The text to send
 * @param {boolean} retry Internal: true if this message called itself again to send failure message
 * @param {number} part Internal: Index of which part to send for messages larger than 750 chars
 */
Bot.prototype.sendChatMessage = function(_this, resInfo, txt, retry, part = 0) {}; // eslint-disable-line

/**
 * Waits for a Steam Chat message from this user to this account and resolves their message content. The "normal" friendMessage event handler will be blocked for this user.
 * @param {string} steamID64 The steamID64 of the user to read a message from
 * @param {number} timeout Time in ms after which the Promise will be resolved if user does not respond. Pass 0 to disable (not recommended)
 * @returns {Promise.<string|null>} Resolved with `String` on response or `null` on timeout.
 */
Bot.prototype.readChatMessage = function(steamID64, timeout) {}; // eslint-disable-line
