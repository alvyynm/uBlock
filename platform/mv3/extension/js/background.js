/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* jshint esversion:11 */

'use strict';

/******************************************************************************/

import { dnr, i18n, runtime } from './ext.js';

/******************************************************************************/

const RULE_REALM_SIZE = 1000000;
const REGEXES_REALM_START = 1000000;
const REGEXES_REALM_END = REGEXES_REALM_START + RULE_REALM_SIZE;
const TRUSTED_DIRECTIVE_BASE_RULE_ID = 8000000;
const CURRENT_CONFIG_BASE_RULE_ID = 9000000;

const dynamicRuleMap = new Map();
const rulesetDetails = new Map();

const rulesetConfig = {
    version: '',
    enabledRulesets: [],
};

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

async function loadRulesetConfig() {
    const configRule = dynamicRuleMap.get(CURRENT_CONFIG_BASE_RULE_ID);
    if ( configRule === undefined ) {
        rulesetConfig.enabledRulesets = await defaultRulesetsFromLanguage();
        return;
    }

    const match = /^\|\|example.invalid\/([^\/]+)\/(?:([^\/]+)\/)?/.exec(
        configRule.condition.urlFilter
    );
    if ( match === null ) { return; }

    rulesetConfig.version = match[1];
    if ( match[2] ) {
        rulesetConfig.enabledRulesets =
            decodeURIComponent(match[2] || '').split(' ');
    }
}

async function saveRulesetConfig() {
    let configRule = dynamicRuleMap.get(CURRENT_CONFIG_BASE_RULE_ID);
    if ( configRule === undefined ) {
        configRule = {
            id: CURRENT_CONFIG_BASE_RULE_ID,
            action: {
                type: 'allow',
            },
            condition: {
                urlFilter: '',
            },
        };
    }

    const version = rulesetConfig.version;
    const enabledRulesets = encodeURIComponent(rulesetConfig.enabledRulesets.join(' '));
    const urlFilter = `||example.invalid/${version}/${enabledRulesets}/`;
    if ( urlFilter === configRule.condition.urlFilter ) { return; }
    configRule.condition.urlFilter = urlFilter;

    return dnr.updateDynamicRules({
        addRules: [ configRule ],
        removeRuleIds: [ CURRENT_CONFIG_BASE_RULE_ID ],
    });
}

/******************************************************************************/

function fetchJSON(filename) {
    return fetch(`/rulesets/${filename}.json`).then(response =>
        response.json()
    ).catch(reason => {
        console.info(reason);
    });
}

/******************************************************************************/

async function updateRegexRules(dynamicRules) {
    // Avoid testing already tested regexes
    const validRegexSet = new Set(
        dynamicRules.filter(rule =>
            rule.condition?.regexFilter && true || false
        ).map(rule =>
            rule.condition.regexFilter
        )
    );
    const allRules = [];
    const toCheck = [];

    // Fetch regexes for all enabled rulesets
    const toFetch = [];
    for ( const details of rulesetDetails.values() ) {
        if ( details.enabled !== true ) { continue; }
        toFetch.push(fetchJSON(`${details.id}.regexes`));
    }
    const regexRulesets = await Promise.all(toFetch);

    // Validate fetched regexes
    let regexRuleId = REGEXES_REALM_START;
    for ( const rules of regexRulesets ) {
        if ( Array.isArray(rules) === false ) { continue; }
        for ( const rule of rules ) {
            rule.id = regexRuleId++;
            const {
                regexFilter: regex,
                isUrlFilterCaseSensitive: isCaseSensitive
            } = rule.condition;
            allRules.push(rule);
            toCheck.push(
                validRegexSet.has(regex)
                    ? { isSupported: true }
                    : dnr.isRegexSupported({ regex, isCaseSensitive })
            );
        }
    }

    // Collate results
    const results = await Promise.all(toCheck);
    const newRules = [];
    for ( let i = 0; i < allRules.length; i++ ) {
        const rule = allRules[i];
        const result = results[i];
        if ( result instanceof Object && result.isSupported ) {
            newRules.push(rule);
        } else {
            console.info(`${result.reason}: ${rule.condition.regexFilter}`);
        }
    }
    console.info(
        `Rejected regex filters: ${allRules.length-newRules.length} out of ${allRules.length}`
    );

    // Add validated regex rules to dynamic ruleset without affecting rules
    // outside regex rule realm.
    const newRuleMap = new Map(newRules.map(rule => [ rule.id, rule ]));
    const addRules = [];
    const removeRuleIds = [];
    for ( const oldRule of dynamicRuleMap.values() ) {
        if ( oldRule.id < REGEXES_REALM_START ) { continue; }
        if ( oldRule.id >= REGEXES_REALM_END ) { continue; }
        const newRule = newRuleMap.get(oldRule.id);
        if ( newRule === undefined ) {
            removeRuleIds.push(oldRule.id);
            dynamicRuleMap.delete(oldRule.id);
        } else if ( JSON.stringify(oldRule) !== JSON.stringify(newRule) ) {
            removeRuleIds.push(oldRule.id);
            addRules.push(newRule);
            dynamicRuleMap.set(oldRule.id, newRule);
        }
    }
    for ( const newRule of newRuleMap.values() ) {
        if ( dynamicRuleMap.has(newRule.id) ) { continue; }
        addRules.push(newRule);
        dynamicRuleMap.set(newRule.id, newRule);
    }
    if ( addRules.length !== 0 || removeRuleIds.length !== 0 ) {
        return dnr.updateDynamicRules({ addRules, removeRuleIds });
    }
}

/******************************************************************************/

async function matchesTrustedSiteDirective(details) {
    const url = new URL(details.origin);
    let rule = dynamicRuleMap.get(TRUSTED_DIRECTIVE_BASE_RULE_ID);
    if ( rule === undefined ) { return false; }
    const domainSet = new Set(rule.condition.requestDomains);
    let hostname = url.hostname;
    for (;;) {
        if ( domainSet.has(hostname) ) { return true; }
        const pos = hostname.indexOf('.');
        if ( pos === -1 ) { break; }
        hostname = hostname.slice(pos+1);
    }
    return false;
}

async function addTrustedSiteDirective(details) {
    const url = new URL(details.origin);
    let rule = dynamicRuleMap.get(TRUSTED_DIRECTIVE_BASE_RULE_ID);
    if ( rule !== undefined ) {
        rule.condition.initiatorDomains = undefined;
        if ( Array.isArray(rule.condition.requestDomains) === false ) {
            rule.condition.requestDomains = [];
        }
    }
    if ( rule === undefined ) {
        rule = {
            id: TRUSTED_DIRECTIVE_BASE_RULE_ID,
            action: {
                type: 'allowAllRequests',
            },
            condition: {
                requestDomains: [ url.hostname ],
                resourceTypes: [ 'main_frame' ],
            },
            priority: TRUSTED_DIRECTIVE_BASE_RULE_ID,
        };
        dynamicRuleMap.set(TRUSTED_DIRECTIVE_BASE_RULE_ID, rule);
    } else if ( rule.condition.requestDomains.includes(url.hostname) === false ) {
        rule.condition.requestDomains.push(url.hostname);
    }
    await dnr.updateDynamicRules({
        addRules: [ rule ],
        removeRuleIds: [ TRUSTED_DIRECTIVE_BASE_RULE_ID ],
    });
    return true;
}

async function removeTrustedSiteDirective(details) {
    const url = new URL(details.origin);
    let rule = dynamicRuleMap.get(TRUSTED_DIRECTIVE_BASE_RULE_ID);
    if ( rule === undefined ) { return false; }
    rule.condition.initiatorDomains = undefined;
    if ( Array.isArray(rule.condition.requestDomains) === false ) {
        rule.condition.requestDomains = [];
    }
    const domainSet = new Set(rule.condition.requestDomains);
    const beforeCount = domainSet.size;
    let hostname = url.hostname;
    for (;;) {
        domainSet.delete(hostname);
        const pos = hostname.indexOf('.');
        if ( pos === -1 ) { break; }
        hostname = hostname.slice(pos+1);
    }
    if ( domainSet.size === beforeCount ) { return false; }
    if ( domainSet.size === 0 ) {
        dynamicRuleMap.delete(TRUSTED_DIRECTIVE_BASE_RULE_ID);
        await dnr.updateDynamicRules({
            removeRuleIds: [ TRUSTED_DIRECTIVE_BASE_RULE_ID ]
        });
        return false;
    }
    rule.condition.requestDomains = Array.from(domainSet);
    await dnr.updateDynamicRules({
        addRules: [ rule ],
        removeRuleIds: [ TRUSTED_DIRECTIVE_BASE_RULE_ID ],
    });
    return false;
}

async function toggleTrustedSiteDirective(details) {
    return details.state
        ? removeTrustedSiteDirective(details)
        : addTrustedSiteDirective(details);
}

/******************************************************************************/

async function enableRulesets(ids) {
    const afterIds = new Set(ids);
    const beforeIds = new Set(await dnr.getEnabledRulesets());
    const enableRulesetIds = [];
    const disableRulesetIds = [];
    for ( const id of afterIds ) {
        if ( beforeIds.has(id) ) { continue; }
        enableRulesetIds.push(id);
    }
    for ( const id of beforeIds ) {
        if ( afterIds.has(id) ) { continue; }
        disableRulesetIds.push(id);
    }
    if ( enableRulesetIds.length !== 0 || disableRulesetIds.length !== 0 ) {
        return dnr.updateEnabledRulesets({ enableRulesetIds,disableRulesetIds  });
    }
}

async function getEnabledRulesetsStats() {
    const ids = await dnr.getEnabledRulesets();
    const out = [];
    for ( const id of ids ) {
        const ruleset = rulesetDetails.get(id);
        if ( ruleset === undefined ) { continue; }
        out.push({
            name: ruleset.name,
            filterCount: ruleset.filters.accepted,
            ruleCount: ruleset.rules.accepted,
        });
    }
    return out;
}

async function defaultRulesetsFromLanguage() {
    const out = [ 'default' ];

    const dropCountry = lang => {
        const pos = lang.indexOf('-');
        if ( pos === -1 ) { return lang; }
        return lang.slice(0, pos);
    };

    const langSet = new Set();

    await i18n.getAcceptLanguages().then(langs => {
        for ( const lang of langs.map(dropCountry) ) {
            langSet.add(lang);
        }
    });
    langSet.add(dropCountry(i18n.getUILanguage()));

    const reTargetLang = new RegExp(
        `\\b(${Array.from(langSet).join('|')})\\b`
    );

    for ( const [ id, details ] of rulesetDetails ) {
        if ( typeof details.lang !== 'string' ) { continue; }
        if ( reTargetLang.test(details.lang) === false ) { continue; }
        out.push(id);
    }
    return out;
}

/******************************************************************************/

async function start() {
    // Fetch enabled rulesets and dynamic rules
    const dynamicRules = await dnr.getDynamicRules();
    for ( const rule of dynamicRules ) {
        dynamicRuleMap.set(rule.id, rule);
    }

    // Fetch ruleset details
    await fetchJSON('ruleset-details').then(entries => {
        if ( entries === undefined ) { return; }
        for ( const entry of entries ) {
            rulesetDetails.set(entry.id, entry);
        }
    });

    await loadRulesetConfig();

    console.log(`Dynamic rule count: ${dynamicRuleMap.size}`);
    console.log(`Available dynamic rule count: ${dnr.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES - dynamicRuleMap.size}`);

    await enableRulesets(rulesetConfig.enabledRulesets);

    // We need to update the regex rules only when ruleset version changes.
    const currentVersion = getCurrentVersion();
    if ( currentVersion !== rulesetConfig.version ) {
        await updateRegexRules(dynamicRules);
        console.log(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        rulesetConfig.version = currentVersion;
    }

    saveRulesetConfig();

    const enabledRulesets = await dnr.getEnabledRulesets();
    console.log(`Enabled rulesets: ${enabledRulesets}`);

    dnr.getAvailableStaticRuleCount().then(count => {
        console.log(`Available static rule count: ${count}`);
    });

    dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
}

/******************************************************************************/

function messageListener(request, sender, callback) {
    switch ( request.what ) {

    case 'getRulesetData': {
        dnr.getEnabledRulesets().then(enabledRulesets => {
            callback({
                enabledRulesets,
                rulesetDetails: Array.from(rulesetDetails.values()),
            });
        });
        return true;
    }

    case 'applyRulesets': {
        enableRulesets(request.enabledRulesets).then(( ) => {
            rulesetConfig.enabledRulesets = request.enabledRulesets;
            return saveRulesetConfig();
        }).then(( ) => {
            callback();
        });
        return true;
    }

    case 'popupPanelData': {
        Promise.all([
            matchesTrustedSiteDirective(request),
            getEnabledRulesetsStats(),
        ]).then(results => {
            callback({
                isTrusted: results[0],
                rulesetDetails: results[1],
            });
        });
        return true;
    }

    case 'toggleTrustedSiteDirective': {
        toggleTrustedSiteDirective(request).then(response => {
            callback(response);
        });
        return true;
    }

    default:
        break;

    }
}

/******************************************************************************/

(async ( ) => {
    await start();

    runtime.onMessage.addListener(messageListener);
})();
