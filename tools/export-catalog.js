#!/usr/bin/env node
/*
 * DeadRamp Base, Phase 0 catalog exporter.
 *
 * Reads the DeadRamp registry (forks.json) plus the groups directory tree
 * from the deadramp repo and emits a self-contained base-catalog.json
 * snapshot into this repo: offerings, vendors, districts, deterministic
 * spiral layout coordinates, and road polylines.
 *
 * The layout math is original parametric work (Archimedean spiral
 * arc-length placement, at world and district scale). See LAYOUT.md.
 *
 * Usage:
 *   node tools/export-catalog.js [--forks <path>] [--groups <dir>] [--out <path>]
 * Defaults:
 *   --forks  ~/workspace/deadramp/forks.json
 *   --groups ~/workspace/deadramp/groups
 *   --out    <repo>/data/base-catalog.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const FORKS = arg('forks', path.join(os.homedir(), 'workspace', 'deadramp', 'forks.json'));
const GROUPS = arg('groups', path.join(os.homedir(), 'workspace', 'deadramp', 'groups'));
const OUT = arg('out', path.join(REPO, 'data', 'base-catalog.json'));

/* ---------------- layout constants (documented in LAYOUT.md) ---------------- */
const LAYOUT = {
  version: 1,
  // World spiral (districts): r(phi) = worldA + worldB * phi
  worldA: 120,          // starting radius, leaves room for the central plaza
  worldB: 90,           // radial growth per radian (turn separation ~565 m)
  districtGap: 70,      // clear arc between neighbouring district edges
  // District sub-spiral (buildings): r(phi) = districtB * phi
  districtB: 9.5,       // radial growth per radian (turn separation ~60 m)
  buildingArcSpacing: 24, // metres of sub-spiral arc per building
  roadHalfWidth: 4.5,   // district road half width
  lotClearance: 1.0,    // gap between road edge and building face
  roadSampleEvery: 5,   // polyline sampling step, metres of arc
  spiralStep: 0.002,    // arc-length table integration step, radians
  goldenAngle: 2.39996322972865332, // district sub-spiral orientation offset step
};

/* ---------------- naming: category -> function slug ----------------
 * Matches the groups/ directory names in the deadramp repo. The special
 * cases below are the names that tree actually uses; everything else goes
 * through the default slugifier. */
const SLUG_OVERRIDES = {
  'Artificial Intelligence (AI)': 'ai',
  'Content Management System (CMS)': 'cms',
  'Customer Relations Management (CRM)': 'crm',
  'Governance, Risk, and Compliance (GRC)': 'grc',
  'Cybersecurity & Risk Management': 'cybersecurity',
  'Mobile Device Management (MDM)': 'mobile-device-management',
  'Uncategorized (none in source)': 'uncategorized',
};
function slugifyCategory(cat) {
  if (SLUG_OVERRIDES[cat]) return SLUG_OVERRIDES[cat];
  return cat
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function tierKeyOf(cmmcTier) {
  if (cmmcTier === null || cmmcTier === undefined) return 'untiered';
  if (cmmcTier === 'L3-adjacent') return 'l3';
  return cmmcTier.toLowerCase(); // L1 -> l1, L2 -> l2
}
const TIER_RANK = { l1: 0, l2: 1, l3: 2, untiered: 3 };
const TIER_LABEL = { l1: 'L1', l2: 'L2', l3: 'L3', untiered: 'Untiered' };

/* District colour family per function (hex). Tier is carried by trim
 * colour in the client, function by body colour family. */
const FUNCTION_COLORS = {
  'accounting': '#8ac926',
  'ai': '#b388ff',
  'analytics': '#4cc9f0',
  'collaboration': '#ffd166',
  'communication': '#06d6a0',
  'construction': '#ef8354',
  'contact-center': '#f4a261',
  'cms': '#e76f51',
  'crm': '#2a9d8f',
  'customer-service': '#e9c46a',
  'cybersecurity': '#ef476f',
  'data-management': '#118ab2',
  'development-tools': '#73d2de',
  'education-training': '#a7c957',
  'finance': '#bc6c25',
  'fleet-management': '#a3b18a',
  'grc': '#9d4edd',
  'grant-management': '#43aa8b',
  'health-wellness': '#f28482',
  'human-resources': '#84a98c',
  'law-enforcement': '#577590',
  'learning-management': '#90be6d',
  'legal-policy': '#b56576',
  'mobile-device-management': '#355070',
  'network-management': '#00b4d8',
  'operations-management': '#fb8500',
  'research': '#c77dff',
  'system-administration': '#3a86ff',
  'talent-development': '#ff70a6',
  'travel-management': '#ffd60a',
  'uncategorized': '#6c757d',
};
function functionColor(slug) {
  if (FUNCTION_COLORS[slug]) return FUNCTION_COLORS[slug];
  // Deterministic fallback for any future function: stable hue from the slug.
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 55%, 60%)`;
}


/* ---------------- brand palettes (evocation only) ----------------
 * The Base's rendition principle: recognizability comes from a few
 * identity cues rendered in the Base's own federal architectural style:
 * the vendor's name (nominative, from Marketplace data) plus its public
 * color palette. Never logos, logotypes, wordmarks, brand fonts,
 * mascots, or trade dress. Colors are a palette, not their artwork.
 *
 * Integrity rule: a palette is marked "researched" only when the
 * vendor's brand colors are unambiguous public knowledge, seeded below
 * by exact registry vendor string. Every other vendor gets the neutral
 * federal finish and is marked "default": honest, not a gap to hide.
 * The full brand research pass is a later, unhurried phase. */
const FEDERAL_FINISH = { primary: '#cfc9b8', secondary: '#4c5257', accent: '#8c6a2f' };
const BRAND_SEEDS = {
  'Microsoft': { primary: '#0078d4', secondary: '#f3f3f3', accent: '#ffb900' },
  'Amazon Web Services, Inc.': { primary: '#232f3e', secondary: '#ffffff', accent: '#ff9900' },
  'Google': { primary: '#4285f4', secondary: '#ffffff', accent: '#34a853' },
  'Salesforce': { primary: '#00a1e0', secondary: '#ffffff', accent: '#1798c1' },
  'Oracle': { primary: '#c74634', secondary: '#ffffff', accent: '#312d2a' },
  'Oracle Corporation': { primary: '#c74634', secondary: '#ffffff', accent: '#312d2a' },
  'IBM': { primary: '#0f62fe', secondary: '#ffffff', accent: '#78a9ff' },
  'Apptio an IBM company': { primary: '#0f62fe', secondary: '#ffffff', accent: '#78a9ff' },
  'Adobe': { primary: '#eb1000', secondary: '#ffffff', accent: '#1e1e1e' },
  'Cisco': { primary: '#1ba0d7', secondary: '#0d274d', accent: '#ffffff' },
  'Cisco Systems Inc.': { primary: '#1ba0d7', secondary: '#0d274d', accent: '#ffffff' },
  'Cisco Systems, Inc.': { primary: '#1ba0d7', secondary: '#0d274d', accent: '#ffffff' },
  'Cisco AppDynamics': { primary: '#1ba0d7', secondary: '#0d274d', accent: '#ffffff' },
  'Duo Security (a Cisco Company)': { primary: '#1ba0d7', secondary: '#0d274d', accent: '#ffffff' },
  'ServiceNow': { primary: '#032d42', secondary: '#ffffff', accent: '#62d84e' },
  'SAP National Security Services Inc. (SAP NS2)': { primary: '#0a6ed1', secondary: '#ffffff', accent: '#00b0d9' },
  'Red Hat': { primary: '#ee0000', secondary: '#151515', accent: '#ffffff' },
  'Atlassian': { primary: '#0052cc', secondary: '#ffffff', accent: '#2684ff' },
  'Workday Inc.': { primary: '#0875c1', secondary: '#ffffff', accent: '#f38b00' },
  'Snowflake Inc.': { primary: '#29b5e8', secondary: '#0f2a44', accent: '#ffffff' },
  'Palantir Technologies': { primary: '#111111', secondary: '#ffffff', accent: '#6b7280' },
  'Palantir Technologies Inc.': { primary: '#111111', secondary: '#ffffff', accent: '#6b7280' },
  'Accenture Federal Services': { primary: '#a100ff', secondary: '#ffffff', accent: '#460073' },
  'Deloitte': { primary: '#101820', secondary: '#ffffff', accent: '#86bc25' },
  'Ernst & Young LLP': { primary: '#1a1a24', secondary: '#ffffff', accent: '#ffe600' },
  'Booz Allen Hamilton': { primary: '#002244', secondary: '#ffffff', accent: '#00a9ce' },
  'Leidos Digital Solutions, Inc.': { primary: '#61269e', secondary: '#ffffff', accent: '#9b7ede' },
  'Broadcom': { primary: '#cc092f', secondary: '#ffffff', accent: '#231f20' },
  'Citrix': { primary: '#0077c8', secondary: '#0c1e3c', accent: '#ffffff' },
  'Citrix Systems, Inc.': { primary: '#0077c8', secondary: '#0c1e3c', accent: '#ffffff' },
  'OpenText': { primary: '#002856', secondary: '#ffffff', accent: '#00a3e0' },
  'Elastic': { primary: '#00bfb3', secondary: '#14181b', accent: '#fec514' },
  'Elastic Cloud Hosted': { primary: '#00bfb3', secondary: '#14181b', accent: '#fec514' },
  'MongoDB': { primary: '#001e2b', secondary: '#ffffff', accent: '#00ed64' },
  'GitHub': { primary: '#171515', secondary: '#ffffff', accent: '#2f81f7' },
  'GitLab': { primary: '#fc6d26', secondary: '#171321', accent: '#fca326' },
  'Box Inc.': { primary: '#0061d5', secondary: '#ffffff', accent: '#003087' },
  'Zoom Video Communications, LLC': { primary: '#2d8cff', secondary: '#ffffff', accent: '#0b5cff' },
  'Okta': { primary: '#00297a', secondary: '#ffffff', accent: '#007dc1' },
  'CrowdStrike, Inc.': { primary: '#e01f26', secondary: '#111111', accent: '#ffffff' },
  'Palo Alto Networks, Inc.': { primary: '#fa582d', secondary: '#101418', accent: '#ff8a00' },
  'Splunk': { primary: '#0c1724', secondary: '#ffffff', accent: '#f26d21' },
  'Databricks, Inc.': { primary: '#ff3621', secondary: '#1b3139', accent: '#ffffff' },
  'Cloudflare': { primary: '#f48120', secondary: '#ffffff', accent: '#faad3f' },
  'Cloudflare, Inc.': { primary: '#f48120', secondary: '#ffffff', accent: '#faad3f' },
  'Akamai': { primary: '#0096d6', secondary: '#ffffff', accent: '#ff9933' },
  'Zscaler, Inc.': { primary: '#0091da', secondary: '#003a70', accent: '#ffffff' },
  'Tenable': { primary: '#00a5b5', secondary: '#00263a', accent: '#ffffff' },
  'Tenable Public Sector (TPS)': { primary: '#00a5b5', secondary: '#00263a', accent: '#ffffff' },
  'Qualys': { primary: '#ed2e26', secondary: '#ffffff', accent: '#1a1a1a' },
  'Qualys, Inc.': { primary: '#ed2e26', secondary: '#ffffff', accent: '#1a1a1a' },
  'SailPoint Technologies, Inc.': { primary: '#0071ce', secondary: '#011e41', accent: '#54c8e8' },
  'SailPoint Technologies, Inc. (Pre SCR review)': { primary: '#0071ce', secondary: '#011e41', accent: '#54c8e8' },
  'SentinelOne': { primary: '#2a0a5e', secondary: '#ffffff', accent: '#7c5cff' },
  'F5, Inc.': { primary: '#e4002b', secondary: '#ffffff', accent: '#1a1a1a' },
  'Proofpoint, Inc.': { primary: '#0072ce', secondary: '#001b41', accent: '#00a9ce' },
  'Mimecast': { primary: '#0090d4', secondary: '#0a1e3c', accent: '#e03c31' },
  'BMC Helix, Inc.': { primary: '#005eb8', secondary: '#ffffff', accent: '#f26522' },
  'Boomi, Inc.': { primary: '#0072ce', secondary: '#033b6b', accent: '#00b0b9' },
  'MuleSoft': { primary: '#00a0df', secondary: '#032d60', accent: '#ffffff' },
  'Appian': { primary: '#0f1e46', secondary: '#ffffff', accent: '#0066f5' },
  'UiPath': { primary: '#fa4616', secondary: '#1f1f1f', accent: '#ffffff' },
  'Scale AI, Inc': { primary: '#000000', secondary: '#ffffff', accent: '#6b7280' },
  'BlackBerry': { primary: '#000000', secondary: '#ffffff', accent: '#8a8d8f' },
  'Motorola Solutions': { primary: '#005eb8', secondary: '#ffffff', accent: '#00a9e0' },
  'ESRI': { primary: '#0079c1', secondary: '#ffffff', accent: '#56b4e7' },
  'Autodesk': { primary: '#111111', secondary: '#ffffff', accent: '#0696d7' },
  'Siemens AG': { primary: '#009e9e', secondary: '#000028', accent: '#00e5a0' },
  'Genesys': { primary: '#ff4f1f', secondary: '#1b1b1b', accent: '#ffffff' },
  'Zendesk': { primary: '#03363d', secondary: '#ffffff', accent: '#cecece' },
  'UKG Inc.': { primary: '#005151', secondary: '#ffffff', accent: '#00a19a' },
  'Cloudera Government Solutions, Inc': { primary: '#f96702', secondary: '#1f1f1f', accent: '#ffffff' },
  'LexisNexis Legal and Professional': { primary: '#ed1c24', secondary: '#1a1a1a', accent: '#ffffff' },
  'LexisNexis Risk Solutions': { primary: '#ed1c24', secondary: '#1a1a1a', accent: '#ffffff' },
  'Thomson Reuters': { primary: '#ff8000', secondary: '#1a1a1a', accent: '#ffffff' },
  'Axon': { primary: '#111111', secondary: '#ffffff', accent: '#ffd500' },
  'Qlik Technologies Inc.': { primary: '#009845', secondary: '#1a1a1a', accent: '#ffffff' },
  /* ---- Phase 4 brand research, tranche 1 (Nov 15, 2026) ----
   * The 40 highest-offering-count default vendors, researched one by
   * one. 24 were established from a citable public source (recorded
   * per entry below) and are seeded here; the other 16 stay on the
   * federal default because no fetched source states their brand
   * colors as hex values (among them Casepoint, whose only listing
   * contradicts its own identity description, and Kiteworks, whose
   * official media kit shows its palette as an image with no hex
   * text). Every value below appears in its cited source. */
  // Brandfetch brand page (Tango, Cobalt, Jagged Ice): https://brandfetch.com/projecthosts.com
  'Project Hosts Inc.': { primary: '#f36d21', secondary: '#003ca5', accent: '#b6e3d4' },
  // Brandfetch brand page (Bay of Many, Turquoise Blue, Black): https://brandfetch.com/stackarmor.com
  'stackArmor': { primary: '#244d80', secondary: '#000000', accent: '#4aeadc' },
  // Brandfetch brand page (Blue, White, Cod Gray): https://brandfetch.com/trellix.com
  'Trellix': { primary: '#2814ff', secondary: '#ffffff', accent: '#1a1a1a' },
  // Brandfetch brand page (Mariner, Midnight, Lightning Yellow): https://brandfetch.com/unisonglobal.com
  'Unison': { primary: '#2e76bc', secondary: '#00133d', accent: '#f8b625' },
  // AvePoint's own G-Cloud document header: PRIMARY COLORS AvePoint Red / AvePoint Indigo,
  // SECONDARY ACCENT COLORS Mint (Sunrise #fdca41 also listed): https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-15/documents/92331/307940440573590-pricing-document-2026-01-29-1101.pdf
  'AvePoint Inc.': { primary: '#ef3b39', secondary: '#3027e2', accent: '#18e9ba' },
  // Brandfetch colors collection for CGI (Crimson, Gigas, Mine Shaft, White): https://brandfetch.com/cgi.com
  'CGI Federal': { primary: '#e11937', secondary: '#ffffff', accent: '#5236ab' },
  // Commvault Brand Guidelines v3, Color chapter, Primary Colors (Peacoat, Cloud, Storm, Raspberry): https://preprod-commvault-legacy.pantheonsite.io/wp-content/uploads/2021/09/Commvault-Brand-Guidelines.pdf
  'Commvault Systems, Inc.': { primary: '#0b2e44', secondary: '#ddeaf3', accent: '#ff4a6a' },
  // Brandfetch brand page for Exiger (near-black ground, slate, violet accent): https://brandfetch.com/exiger.com
  'Covergent Solutions Inc dba Exiger Government Solutions (EGS)': { primary: '#121318', secondary: '#4b4e5a', accent: '#8b6eff' },
  // Brandfetch brand page for Deltek: https://brandfetch.com/deltek.com
  'Deltek - Replicon': { primary: '#0063a3', secondary: '#ffffff', accent: '#72767b' },
  // Docusign's own brand guidelines color page (Cobalt is the primary brand color;
  // Inkwell a secondary; Poppy the accent): https://brand.docusign.com/color
  'DocuSign': { primary: '#4c00ff', secondary: '#130032', accent: '#ff5252' },
  // Brandfetch brand page: https://brandfetch.com/dynatrace.com
  'Dynatrace': { primary: '#3481f4', secondary: '#000000', accent: '#ffffff' },
  // HP Visual Identity 2022 logo guidelines: the logo colors are Black, White and
  // HP Corporate blue; the blue's hex (0096D6, Pantone 2925 C) is stated in HP's logo
  // specification documents: https://cdn.relayto.com/media/files/HP_Logo_Guidelines_2.0_3e28e05e435848fd89e8d1442689a548.pdf
  'HP Inc.': { primary: '#0096d6', secondary: '#ffffff', accent: '#000000' },
  // Ivanti Brand Expression Guide (August 2025), Colors page primary scale
  // (Ivanti Red #ff1515 is the named logo color; deep purple and orange are the scale anchors): https://palti.com.co/wp-content/uploads/2026/01/Ivanti-Brand-Expression-Guide-compressed.pdf
  'Ivanti': { primary: '#ff1515', secondary: '#280b3f', accent: '#ff8303' },
  // Keeper Security's own USPTO trademark application (Serial 97137705), colors claimed
  // for the mark: Black (000000), Gold (FFC700), White (FFFFFF): https://trademarks.justia.com/971/37/n-97137705.html
  'Keeper Security': { primary: '#000000', secondary: '#ffffff', accent: '#ffc700' },
  // Brandfetch brand page, claimed brand (Vermilion, Black, Deep Teal, Aubergine, Vapor): https://brandfetch.com/knowbe4.com
  'KnowBe4, Inc.': { primary: '#ef4523', secondary: '#101820', accent: '#00293c' },
  // Brandfetch brand page: https://brandfetch.com/maximus.com
  'MAXIMUS Inc.': { primary: '#502d90', secondary: '#ffffff', accent: '#4a4a4a' },
  // NinjaOne Brand Guide v1.5, logotype colors and palette page ("the primary palette
  // color is blue, paired with a vivid green"): https://images.ninjaone.com/wp-content/uploads/2026/01/NinjaOne-Brand-Guide-v1.5.pdf
  'NinjaOne': { primary: '#053856', secondary: '#ffffff', accent: '#04ff88' },
  // Nintex Brand Guidelines v2.2, Colors page (primary: Nintex Orange, Nintex Charcoal;
  // secondary: Red, Amber, Grey): http://nintexdownload.com/Nsupport/Nintex_Brand_Guidelines.pdf
  'Nintex': { primary: '#ff7900', secondary: '#323232', accent: '#ff0f00' },
  // Brandfetch brand page, claimed brand (Blue Ribbon, Big Stone, Island Spice): https://brandfetch.com/skillsoft.com
  'Skillsoft': { primary: '#1f69fc', secondary: '#151c36', accent: '#fffbee' },
  // Slack Brand Guidelines, Colors page ("Aubergine is our brand primary color";
  // Aubergine Null is its surface variant; Blue is the lead logo color): https://a.slack-edge.com/3f2ae/marketing/img/media-kit/Slack-Brand-Guidelines.pdf
  'Slack Technologies': { primary: '#4a154b', secondary: '#611f69', accent: '#36c5f0' },
  // Trend Micro's own brand palette page (Trend Red, White, Rich Black): https://resources.trendmicro.com/Hybrid-Cloud-Security-Contact-Us.html
  'Trend Micro Inc.': { primary: '#d71920', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page for Tyler Technologies (blue wordmark, deep blue, green): https://brandfetch.com/tylertech.com
  'Tyler Federal, LLC': { primary: '#1278c0', secondary: '#045590', accent: '#909b48' },
  // USDA's official Design and Brand page, "USDA Colors": the official logo colors are
  // Dark Blue #002d72 (PMS 288) and Dark Green #005440 (PMS 343); the same page sets the
  // logo on a white masthead field: https://www.usda.gov/digital-strategy/design-and-brand/plays
  'United States Department of Agriculture': { primary: '#002d72', secondary: '#ffffff', accent: '#005440' },
  // Brandfetch brand page, claimed brand (Royal Blue, Ebony, White): https://brandfetch.com/wiz.io
  'Wiz, Inc.': { primary: '#325fe8', secondary: '#0f172a', accent: '#ffffff' },
  /* ---- Phase 4 brand research, tranche 2 (Nov 15, 2026) ----
   * The next 60 default vendors by offering count (the sixteen
   * 2-offering vendors, then single-offering vendors in registry
   * order), researched one by one. 52 were established from a citable
   * public source (recorded per entry below) and are seeded here;
   * the other 8 stay on the federal default: Advent Business Company
   * Inc., Aeroplicity Inc., Aequitas Cyber Labs and ArcSuite AI have
   * no citable source stating hex values; the only Knox Systems
   * listing contradicts itself (its About section describes Google
   * Workspace) and the only CLEAR listing likewise (its description
   * is an automotive-care company); Acuant's listing now describes
   * its acquirer GBG; Specset's only listing states exactly two
   * colors, so no third value is citable. Tranche 1's two holdouts
   * moved: the current Casepoint listing describes the legal
   * discovery company correctly, and Kiteworks now has a listing
   * stating hex as text. Every value below appears in its cited
   * source, verified against the fetched page. */
  // Brandfetch brand page, palette stated in its FAQ (the page describes the
  // legal discovery platform; no color names listed): https://brandfetch.com/casepoint.com
  'Casepoint LLC': { primary: '#ffc83a', secondary: '#ffffff', accent: '#783013' },
  // Brandfetch brand page (Royal Blue, Malibu, Blue Zodiac): https://brandfetch.com/everbridge.com
  'Everbridge': { primary: '#3760f3', secondary: '#8ed1fc', accent: '#13284e' },
  // Brandfetch brand page (Cornflower Blue, White, Martinique): https://brandfetch.com/fmsystems.com
  'FM:Systems': { primary: '#576efa', secondary: '#ffffff', accent: '#2d3049' },
  // Brandfetch brand page (Cerulean, White, Black Pearl): https://brandfetch.com/intelligrc.com
  'IntelliGRC, Inc.': { primary: '#00bbde', secondary: '#ffffff', accent: '#030d28' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/ironmountain.com
  'Iron Mountain': { primary: '#8c0e70', secondary: '#196db2', accent: '#023459' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/kiteworks.com
  'Kiteworks USA, LLC': { primary: '#485bbf', secondary: '#ffffff', accent: '#0d0f31' },
  // Brandfetch brand page (Blue Ribbon, Science Blue, Spring Green; Hot Pink and Mine Shaft also listed): https://brandfetch.com/paramify.com
  'Paramify': { primary: '#1467ff', secondary: '#004bd6', accent: '#20fc8f' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/samsara.com
  'Samsara Inc.': { primary: '#ffae10', secondary: '#1b1917', accent: '#ffffff' },
  // San Luis Aviation, Inc. does business as ESChat, and its registry offerings are the
  // ESChat services; Brandfetch brand page for ESChat, palette stated in its FAQ
  // (no color names listed): https://brandfetch.com/eschat.com
  'San Luis Aviation, Inc.': { primary: '#428bca', secondary: '#ffffff', accent: '#191919' },
  // Brandfetch brand page for the Treasury Department, palette stated in its FAQ
  // (no color names listed): https://brandfetch.com/treasury.gov
  'United States Department of the Treasury': { primary: '#0053a2', secondary: '#9cc3e2', accent: '#00040f' },
  // Brandfetch brand page (Azure Radiance, Malibu, Ebony): https://brandfetch.com/varonis.com
  'Varonis': { primary: '#0077ff', secondary: '#7391ff', accent: '#010203' },
  // Brandfetch brand page (Flame Pea, Viola, Orange Roughy): https://brandfetch.com/vyond.com
  'Vyond': { primary: '#d95e28', secondary: '#c07c9e', accent: '#c84d16' },
  // Brandfetch brand page (Wild Strawberry, White, Black): https://brandfetch.com/wellhive.com
  'WellHive Holdings, LLC': { primary: '#ff4180', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page for cloud.gov, which the page states is built by 18F;
  // palette stated in its FAQ (no color names listed): https://brandfetch.com/cloud.gov
  '18F - 18F Cloud.gov': { primary: '#0076d6', secondary: '#ffffff', accent: '#1b1b1b' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/38northsecurity.com
  '38North Security, LLC': { primary: '#081ebc', secondary: '#ed9466', accent: '#222222' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/3rdeyetechinc.com
  '3rd Eye Technologies LLC.': { primary: '#e32200', secondary: '#cedddf', accent: '#000000' },
  // Brandfetch brand page (Blaze Orange, Whiskey, Cello): https://brandfetch.com/86borders.com
  '86Borders LLC': { primary: '#fe660f', secondary: '#d49c73', accent: '#203c58' },
  // Brandfetch brand page (Alizarin Crimson, Equator, Tosca): https://brandfetch.com/911inform.com
  '911inform': { primary: '#d92128', secondary: '#e2a762', accent: '#8d414a' },
  // Brandfetch brand page (Chartreuse Yellow, White, Firefly): https://brandfetch.com/a-lign.com
  'A-LIGN': { primary: '#dcff07', secondary: '#ffffff', accent: '#081a21' },
  // Brandfetch brand page, palette stated in its FAQ (five hex codes listed; the page
  // describes the identity as deep navy and vivid periwinkle with white): https://brandfetch.com/abbott.com
  'Abbott, Inc.': { primary: '#2e4aed', secondary: '#ffffff', accent: '#000075' },
  // Brandfetch brand page (Las Palmas, White, Trendy Green): https://brandfetch.com/abnormal.ai
  'Abnormal AI': { primary: '#c7e913', secondary: '#ffffff', accent: '#7c8f1f' },
  // Brandfetch brand page (Lima, Electric Violet, Black): https://brandfetch.com/absolute.com
  'Absolute Security': { primary: '#78be20', secondary: '#7a3ff1', accent: '#000000' },
  // Brandfetch brand page (Rajah, Mountain Meadow, White; Bahama Blue also listed): https://brandfetch.com/achieveit.com
  'AchieveIt Online, LLC': { primary: '#f6b267', secondary: '#1abc9c', accent: '#ffffff' },
  // Brandfetch brand page (Razzmatazz, White, Big Stone): https://brandfetch.com/acquia.com
  'Acquia Inc.': { primary: '#e1126e', secondary: '#ffffff', accent: '#141938' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/actsoft.com
  'Actsoft, Inc': { primary: '#4caf50', secondary: '#ff5d38', accent: '#000000' },
  // Brandfetch brand page (Science Blue, White, Black): https://brandfetch.com/adaptiva.com
  'Adaptive Protocols, Inc. (Adaptiva)': { primary: '#0860b8', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/agilefleet.com
  'Agile Fleet': { primary: '#3a74b7', secondary: '#f2cda0', accent: '#214672' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/agilerank.com
  'AgileRank': { primary: '#fd6262', secondary: '#ffffff', accent: '#141416' },
  // AINS does business as OPEXUS (the registry name itself); Brandfetch brand page
  // for OPEXUS (Cannon Pink, Spindle, Ebony): https://brandfetch.com/opexustech.com
  'AINS dba OPEXUS': { primary: '#8a4386', secondary: '#b0c6e7', accent: '#010203' },
  // Brandfetch brand page (Orange Peel, Tamarind, Hot Cinnamon; White also listed): https://brandfetch.com/alation.com
  'Alation': { primary: '#ff9900', secondary: '#2b0f17', accent: '#e3682a' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/altana.ai
  'Altana': { primary: '#273da6', secondary: '#96a5ea', accent: '#0b0b0b' },
  // The association's own Condensed Brand Guidelines, Color Palette section
  // (White, AHA Red, Deep Red, Gray, Black; AHA Red is the brand color and
  // Deep Red its stated accent): https://www.heart.org/-/media/Files/Brand/AHA_Masterbrand_Guidelines_Condensed.pdf
  'American Heart Association, Inc.': { primary: '#cf222b', secondary: '#ffffff', accent: '#990000' },
  // Brandfetch brand page (Mexican Red, Prelude, Blue Zodiac): https://brandfetch.com/amplifire.com
  'Amplifire': { primary: '#a82a25', secondary: '#cabbe8', accent: '#0a1835' },
  // Brandfetch brand page (Di Serria, White, Thunder): https://brandfetch.com/andesite.ai
  'Andesite AI, Inc.': { primary: '#d1a05a', secondary: '#ffffff', accent: '#2c262c' },
  // Brandfetch brand page (Bright Turquoise, Wild Strawberry, Black Pearl): https://brandfetch.com/anecdotes.ai
  'Anecdotes': { primary: '#00dce8', secondary: '#ff3499', accent: '#031926' },
  // Brandfetch brand page (Denim, Flamingo, Downriver): https://brandfetch.com/anitian.com
  'Anitian': { primary: '#1870b8', secondary: '#f75227', accent: '#0b3354' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/anomali.com
  'Anomali Inc': { primary: '#27dab3', secondary: '#6eb8eb', accent: '#0a1736' },
  // Anthropic's own brand guidelines in its anthropics/skills repository
  // (Main Colors: Dark, Light, Mid Gray, Light Gray; Accent Colors: Orange is
  // the primary accent, then Blue and Green): https://www.skills.sh/anthropics/skills/brand-guidelines
  'Anthropic': { primary: '#141413', secondary: '#faf9f5', accent: '#d97757' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/anyreach.ai
  'Anyreach, Inc.': { primary: '#6366f1', secondary: '#a4b3fc', accent: '#18181b' },
  // Anysphere is the company behind Cursor, as the page itself states; Brandfetch
  // brand page for Cursor, palette stated in its FAQ (no color names listed): https://brandfetch.com/cursor.com
  'Anysphere, Inc.': { primary: '#f54e00', secondary: '#f7f7f4', accent: '#26251e' },
  // Brandfetch brand page (Dark Blue, Downriver, Dodger Blue): https://brandfetch.com/applygovernmentsolutions.com
  'Apply Government Solutions': { primary: '#0030d2', secondary: '#0a1540', accent: '#42b9ff' },
  // Brandfetch brand page (Viking, Jungle Mist, Chathams Blue): https://brandfetch.com/appomni.com
  'AppOmni': { primary: '#61b2e1', secondary: '#c1d4d9', accent: '#193c81' },
  // Brandfetch brand page (Persian Green, Ziggurat, Scarlet Gum): https://brandfetch.com/aprimo.com
  'Aprimo US, LLC': { primary: '#00a6a1', secondary: '#b5d5e0', accent: '#521163' },
  // Brandfetch brand page (Supernova, Aquamarine, Torch Red; Resolution Blue and White also listed): https://brandfetch.com/aquasec.com
  'Aqua Security Software Inc.': { primary: '#ffc900', secondary: '#51f0ff', accent: '#ff0036' },
  // Brandfetch brand page (Starship, White, Black Pearl): https://brandfetch.com/archive360.com
  'Archive360 platform': { primary: '#f1dd43', secondary: '#ffffff', accent: '#02020b' },
  // Brandfetch brand page (Tolopea, White, Pigment Indigo): https://brandfetch.com/ardoq.com
  'Ardoq Inc': { primary: '#1f003b', secondary: '#ffffff', accent: '#4c008f' },
  // Brandfetch brand page: two named swatches (Dodger Blue, Pueblo); the third hex
  // is from the page's own palette sentence, in that order: https://brandfetch.com/armada.ai
  'Armada': { primary: '#297fff', secondary: '#ffe2a8', accent: '#6f300f' },
  // Brandfetch brand page (Blumine, White, Tuna): https://brandfetch.com/armedia.com
  'Armedia, LLC': { primary: '#1f6581', secondary: '#ffffff', accent: '#32323a' },
  // Armis Federal carries the parent Armis brand; Brandfetch brand page
  // (Electric Violet, Dodger Blue, White; Baltic Sea also listed): https://brandfetch.com/armis.com
  'Armis Federal LLC': { primary: '#8017f0', secondary: '#2abaff', accent: '#ffffff' },
  // Brandfetch brand page (Purple Heart, White, Jambalaya): https://brandfetch.com/artera.io
  'Artera': { primary: '#9631d8', secondary: '#ffffff', accent: '#562b11' },
  // Brandfetch brand page (Picton Blue, Cinnabar, Congress Blue): https://brandfetch.com/articulate.com
  'Articulate Global LLC': { primary: '#4cbcf4', secondary: '#ea4434', accent: '#005492' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/asana.com
  'Asana Inc.': { primary: '#ff6d92', secondary: '#0d0d0d', accent: '#ffffff' },
};
function brandFor(vendorName) {
  const seed = BRAND_SEEDS[vendorName];
  if (seed) return { primary: seed.primary, secondary: seed.secondary, accent: seed.accent, source: 'researched' };
  return { primary: FEDERAL_FINISH.primary, secondary: FEDERAL_FINISH.secondary, accent: FEDERAL_FINISH.accent, source: 'default' };
}

/* The two offerings the DeadRamp build record holds as honestly
 * unclassified (see deadramp MAP.md / BASE-PLAN.md ground truth):
 * TERIDA CLASsoft (FR1901852210) and USDA vGov (AGENCYNITCIAAS).
 * Matched on the marketplace product id inside source_url. */
const UNCLASSIFIED_IDS = ['FR1901852210', 'AGENCYNITCIAAS'];
function isUnclassified(offering) {
  return UNCLASSIFIED_IDS.some((id) => (offering.source_url || '').includes(id));
}

/* ---------------- Phase 2: room records and build records ----------------
 * Every offering gets a room, generated from what the DeadRamp source
 * repo actually holds for it:
 *
 *   - Its Marketplace spec entry in groups/<group>/specs/specs.json,
 *     joined by fork_id (the product id inside source_url). The spec
 *     carries the offering's own description, deployment model, and
 *     claimed functions. Exactly two offerings have no spec entry: the
 *     two the build holds as unclassified (TERIDA CLASsoft, USDA
 *     vGov). Their rooms record that plainly (buildGroup null).
 *
 *   - The group's merged clean-room reference build under
 *     groups/<group>/ (README label, src modules, CLI surface, HTTP
 *     surface, control catalog where the build carries one, test
 *     counts, and a SHA-256 file manifest for provenance). Build data
 *     is stored once per group in the catalog's `builds` map; rooms
 *     reference it by group name. Nothing is paraphrased into facts
 *     the source does not hold: extraction is verbatim strings, names,
 *     and counts from the source files.
 *
 * Room archetypes follow the offering's own function (LAYOUT.md):
 * the archetype is the room's shape; the data on its walls is the
 * offering's own record. The generic federal office is the fallback.
 */
const ARCHETYPE_BY_FUNCTION = {
  'cybersecurity': 'ops-center', 'grc': 'ops-center', 'law-enforcement': 'ops-center',
  'network-management': 'ops-center', 'system-administration': 'ops-center',
  'operations-management': 'ops-center',
  'cloud-infrastructure-hosting': 'server-hall', 'data-management': 'server-hall',
  'mobile-device-management': 'server-hall',
  'ai': 'lab', 'analytics': 'lab', 'research': 'lab', 'development-tools': 'lab',
  'collaboration': 'meeting-space', 'communication': 'meeting-space',
  'contact-center': 'meeting-space', 'crm': 'meeting-space', 'customer-service': 'meeting-space',
  'accounting': 'ledger-office', 'finance': 'ledger-office', 'grant-management': 'ledger-office',
};
function archetypeFor(fn) { return ARCHETYPE_BY_FUNCTION[fn] || 'federal-office'; }

function forkIdOf(sourceUrl) {
  const m = /\/products\/([^/]+)\//.exec(sourceUrl || '');
  return m ? m[1] : null;
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function walkFiles(dir, suffix) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === '__pycache__') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walkFiles(p, suffix));
    else if (name.endsWith(suffix)) out.push(p);
  }
  return out;
}
function plainText(md) {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/* First module docstring's first line, verbatim (trimmed). */
function moduleDoc(text) {
  const m = /^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(text);
  if (!m) return '';
  const line = m[1].split('\n').map((s) => s.trim()).find((s) => s.length > 0);
  return line || '';
}
/* CLI surface: argparse subcommands from __main__.py, verbatim names
 * and help strings. */
function extractCli(text) {
  const byName = new Map();
  const re = /add_parser\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (byName.has(m[1])) continue;
    const tail = text.slice(m.index, m.index + 500);
    const hm = /help\s*=\s*"([^"]*)"/.exec(tail) || /help\s*=\s*'([^']*)'/.exec(tail);
    byName.set(m[1], hm ? hm[1] : '');
  }
  return [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, help]) => ({ name, help }));
}
/* HTTP surface of the group's service module, extracted only where the
 * source states it literally: full routes stated as method + literal
 * path segment lists, the router's operation names (first element of
 * the returned route tuples), and the resource roots it dispatches on.
 * Nothing is inferred beyond those literals. */
function extractHttp(text) {
  const routes = new Set();
  const segList = (raw) => {
    const segs = [];
    for (const part of raw.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const q = /^"([^"]*)"$/.exec(t) || /^'([^']*)'$/.exec(t);
      if (!q) return null;
      segs.push(q[1]);
    }
    return segs;
  };
  const reA = /method\s*==\s*"(GET|POST|PUT|PATCH|DELETE)"\s*and\s*parts\s*==\s*\[([^\]]*)\]/g;
  const reB = /parts\s*==\s*\[([^\]]*)\]\s*and\s*method\s*==\s*"(GET|POST|PUT|PATCH|DELETE)"/g;
  let m;
  while ((m = reA.exec(text)) !== null) { const s = segList(m[2]); if (s) routes.add(`${m[1]} /${s.join('/')}`); }
  while ((m = reB.exec(text)) !== null) { const s = segList(m[1]); if (s) routes.add(`${m[2]} /${s.join('/')}`); }
  /* Second router style: a declarative ROUTES table of
   * ("METHOD", ("seg", "{id}"), permission, "_handler") tuples. */
  const reTable = /\("(GET|POST|PUT|PATCH|DELETE)",\s*\(([^)]*)\)/g;
  while ((m = reTable.exec(text)) !== null) {
    const segs = [];
    let ok = true;
    for (const part of m[2].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const q = /^"([^"]*)"$/.exec(t) || /^'([^']*)'$/.exec(t);
      if (!q) { ok = false; break; }
      segs.push(q[1]);
    }
    if (ok && segs.length) routes.add(`${m[1]} /${segs.join('/')}`);
  }
  const operations = new Set();
  const reOp = /return\s*\(\s*"([a-z][a-z0-9_]*)"\s*,/g;
  while ((m = reOp.exec(text)) !== null) operations.add(m[1]);
  const reHandler = /\("(?:GET|POST|PUT|PATCH|DELETE)",\s*\([^)]*\)\s*,\s*(?:"[^"]*"|None)\s*,\s*"(_[a-z][a-z0-9_]*)"/g;
  while ((m = reHandler.exec(text)) !== null) operations.add(m[1].slice(1));
  /* Third router style: the router dispatches inline and invokes the
   * store's operations directly (store.create_organization(...)). The
   * operation names are those invoked store methods, verbatim. */
  const reStore = /\bstore\.([a-z][a-z0-9_]*)\s*\(/g;
  while ((m = reStore.exec(text)) !== null) operations.add(m[1]);
  const resources = new Set();
  const reRes = /parts\[0\]\s*==\s*"([^"]+)"/g;
  while ((m = reRes.exec(text)) !== null) resources.add(m[1]);
  const cap = (set, n) => [...set].sort().slice(0, n);
  return {
    routes: cap(routes, 48), routesTotal: routes.size,
    operations: cap(operations, 64), operationsTotal: operations.size,
    resources: cap(resources, 32), resourcesTotal: resources.size,
  };
}
/* NIST SP 800-53 control tuples ("AC-2", "Account Management") where a
 * build carries a control catalog table. Verbatim pairs. */
function extractControls(text) {
  const byId = new Map();
  const re = /\("([A-Z]{2}-\d+)",\s*"([^"]{3,90})"\)/g;
  let m;
  while ((m = re.exec(text)) !== null) if (!byId.has(m[1])) byId.set(m[1], m[2]);
  return [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([id, title]) => ({ id, title }));
}
function extractBuild(groupDir, root) {
  const gdir = path.join(root, 'groups', groupDir);
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const readmePath = path.join(gdir, 'README.md');
  let title = '', summary = '';
  if (fs.existsSync(readmePath)) {
    const md = fs.readFileSync(readmePath, 'utf8');
    const lines = md.split('\n');
    const tIdx = lines.findIndex((l) => l.startsWith('# '));
    if (tIdx >= 0) title = lines[tIdx].slice(2).trim();
    const para = [];
    for (let i = tIdx + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) { if (para.length) break; else continue; }
      if (l.startsWith('#')) break;
      para.push(l);
    }
    summary = plainText(para.join(' '));
    if (summary.length > 800) summary = summary.slice(0, 800).replace(/\s+\S*$/, '') + '…';
  }
  const srcFiles = walkFiles(path.join(gdir, 'src'), '.py');
  const modules = [], manifest = [];
  let cliText = '', http = { routes: [], routesTotal: 0, operations: [], operationsTotal: 0, resources: [], resourcesTotal: 0 };
  let controls = [], controlsSource = null;
  for (const f of srcFiles) {
    const buf = fs.readFileSync(f);
    const text = buf.toString('utf8');
    modules.push({ path: rel(f), doc: moduleDoc(text) });
    manifest.push({ path: rel(f), bytes: buf.length, sha256: sha256(buf) });
    if (path.basename(f) === '__main__.py') cliText += text + '\n';
    if (path.basename(f) === 'service.py') http = extractHttp(text);
    if (!controls.length) {
      const c = extractControls(text);
      if (c.length) { controls = c; controlsSource = rel(f); }
    }
  }
  const testFiles = walkFiles(path.join(gdir, 'tests'), '.py')
    .filter((f) => path.basename(f).startsWith('test_'));
  let testCount = 0;
  for (const f of testFiles) {
    testCount += (fs.readFileSync(f, 'utf8').match(/^\s*def test_/gm) || []).length;
  }
  const srcDir = path.join(gdir, 'src');
  const pkgDirs = fs.existsSync(srcDir)
    ? fs.readdirSync(srcDir).filter((d) => fs.statSync(path.join(srcDir, d)).isDirectory() && d !== '__pycache__').sort()
    : [];
  return {
    groupDir,
    title, summary,
    package: pkgDirs.length === 1 ? pkgDirs[0] : (pkgDirs[0] || null),
    modules, manifest,
    cli: extractCli(cliText),
    http, controls, controlsSource,
    testFiles: testFiles.length, testCount,
    specCount: 0, // filled in by the caller once the spec join is known
  };
}
/* Index every spec entry by fork_id, and extract every group's build. */
function loadBuildData(root, groupDirs) {
  const specIndex = new Map();
  for (const g of [...groupDirs].sort()) {
    const sp = path.join(root, 'groups', g, 'specs', 'specs.json');
    if (!fs.existsSync(sp)) continue;
    for (const entry of JSON.parse(fs.readFileSync(sp, 'utf8'))) {
      if (entry && entry.fork_id && !specIndex.has(entry.fork_id)) {
        specIndex.set(entry.fork_id, { group: g, entry });
      }
    }
  }
  const builds = {};
  for (const g of [...groupDirs].sort()) {
    if (!fs.existsSync(path.join(root, 'groups', g, 'specs', 'specs.json'))) continue;
    builds[g] = extractBuild(g, root);
  }
  for (const hit of specIndex.values()) {
    if (builds[hit.group]) builds[hit.group].specCount++;
  }
  return { specIndex, builds };
}
function roomFor(offering, specHit) {
  const e = specHit ? specHit.entry : null;
  return {
    archetype: archetypeFor(offering.function),
    buildGroup: specHit ? specHit.group : null,
    specPath: specHit ? `groups/${specHit.group}/specs/specs.json` : null,
    forkId: forkIdOf(offering.source_url),
    deploymentModel: e ? (e.deployment_model ?? null) : null,
    description: e ? (e.description ?? null) : null,
    functions: e && Array.isArray(e.functions_claimed)
      ? e.functions_claimed.map((f) => ({ id: f.function_id, name: f.function })) : [],
    specSource: e ? (e.source ?? null) : null,
  };
}

/* ---------------- spiral arc-length walker ----------------
 * Archimedean spiral r(phi) = a + b*phi. Builds a fixed-step arc-length
 * table once (deterministic), then answers point/tangent queries by
 * binary search plus linear interpolation. */
function makeSpiralWalker(a, b, maxArc) {
  const pts = [{ phi: 0, x: a, z: 0, s: 0 }];
  let phi = 0;
  let px = a, pz = 0, s = 0;
  const step = LAYOUT.spiralStep;
  while (s < maxArc) {
    phi += step;
    const r = a + b * phi;
    const x = r * Math.cos(phi), z = r * Math.sin(phi);
    s += Math.hypot(x - px, z - pz);
    pts.push({ phi, x, z, s });
    px = x; pz = z;
  }
  function pointAt(target) {
    if (target <= 0) return { x: pts[0].x, z: pts[0].z, tx: 0, tz: 1, phi: 0 };
    let lo = 0, hi = pts.length - 1;
    if (target >= pts[hi].s) { const p = pts[hi]; const q = pts[hi - 1]; const dx = p.x - q.x, dz = p.z - q.z; const m = Math.hypot(dx, dz) || 1; return { x: p.x, z: p.z, tx: dx / m, tz: dz / m, phi: p.phi }; }
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (pts[mid].s < target) lo = mid; else hi = mid; }
    const p0 = pts[lo], p1 = pts[hi];
    const f = (target - p0.s) / ((p1.s - p0.s) || 1);
    const x = p0.x + (p1.x - p0.x) * f, z = p0.z + (p1.z - p0.z) * f;
    const dx = p1.x - p0.x, dz = p1.z - p0.z, m = Math.hypot(dx, dz) || 1;
    return { x, z, tx: dx / m, tz: dz / m, phi: p0.phi + (p1.phi - p0.phi) * f };
  }
  return { pointAt, totalArc: s };
}
const r3 = (n) => Math.round(n * 1000) / 1000;

/* Building size from offering count (documented in LAYOUT.md). */
function buildingSize(n) {
  return {
    w: Math.min(18, 10 + 2 * (n - 1)),
    d: Math.min(26, 12 + 3 * (n - 1)),
    h: Math.min(60, 9 + 6 * (n - 1) + (n >= 5 ? 6 : 0)),
  };
}

function main() {
  const forks = JSON.parse(fs.readFileSync(FORKS, 'utf8'));
  const groupDirs = new Set(fs.readdirSync(GROUPS).filter((d) => fs.statSync(path.join(GROUPS, d)).isDirectory()));
  // The DeadRamp repo root is the parent of the groups tree.
  const ROOT = path.dirname(GROUPS);
  const { specIndex, builds } = loadBuildData(ROOT, groupDirs);

  /* ---- offerings with district assignment ---- */
  const offerings = forks.map((f, idx) => {
    const fn = slugifyCategory(f.category);
    const tk = tierKeyOf(f.cmmc_tier);
    const o = {
      registryIndex: idx,
      vendor: f.vendor,
      product: f.product,
      service_model: f.service_model,
      fedramp_impact_level: f.fedramp_impact_level,
      authorization_status: f.authorization_status,
      category: f.category,
      cmmc_tier: f.cmmc_tier,
      source_url: f.source_url,
      function: fn,
      tier: TIER_LABEL[tk],
      tierKey: tk,
      district: `${fn}-${tk}`,
      unclassified: isUnclassified(f),
    };
    o.room = roomFor(o, specIndex.get(forkIdOf(f.source_url)));
    return o;
  });

  /* ---- districts (function x tier), deterministic order ---- */
  const districtMap = new Map();
  for (const o of offerings) {
    if (!districtMap.has(o.district)) {
      districtMap.set(o.district, {
        id: o.district,
        function: o.function,
        functionName: o.category,
        tier: o.tier,
        tierKey: o.tierKey,
        color: functionColor(o.function),
        inGroupsTree: groupDirs.has(o.district),
        offeringIndexes: [],
      });
    }
    districtMap.get(o.district).offeringIndexes.push(o.registryIndex);
  }
  const districts = [...districtMap.values()].sort((a, b) =>
    a.function.localeCompare(b.function) || (TIER_RANK[a.tierKey] - TIER_RANK[b.tierKey]));

  /* ---- vendors ---- */
  const vendorMap = new Map();
  for (const o of offerings) {
    if (!vendorMap.has(o.vendor)) vendorMap.set(o.vendor, []);
    vendorMap.get(o.vendor).push(o);
  }
  const vendorNames = [...vendorMap.keys()]; // registry order of first appearance

  // Home district: plurality of the vendor's offerings; ties broken by the
  // district of the vendor's earliest offering, then district id.
  function homeDistrict(list) {
    const counts = new Map();
    for (const o of list) counts.set(o.district, (counts.get(o.district) || 0) + 1);
    let best = null;
    for (const [d, c] of counts) {
      const earliest = Math.min(...list.filter((o) => o.district === d).map((o) => o.registryIndex));
      if (!best || c > best.c || (c === best.c && (earliest < best.earliest || (earliest === best.earliest && d < best.d)))) {
        best = { d, c, earliest };
      }
    }
    return best.d;
  }

  const vendors = vendorNames.map((name, i) => {
    const list = vendorMap.get(name);
    const certified = list.filter((o) => o.authorization_status === 'FedRAMP Certified').length;
    const allUnclassified = list.every((o) => o.unclassified);
    return {
      id: 'v' + String(i + 1).padStart(4, '0'),
      name,
      district: homeDistrict(list),
      districts: [...new Set(list.map((o) => o.district))].sort(),
      offeringCount: list.length,
      statusClass: certified === list.length ? 'certified' : certified === 0 ? 'pipeline' : 'mixed',
      brand: brandFor(name),
      kind: allUnclassified ? 'lot' : 'building',
      offerings: list,
      _firstIndex: list[0].registryIndex,
    };
  });

  /* ---- layout: district sizes first ---- */
  for (const d of districts) {
    d.vendors = vendors.filter((v) => v.district === d.id)
      .sort((a, b) => a._firstIndex - b._firstIndex)
      .map((v) => v.id);
    d.vendorCount = d.vendors.length;
    d.offeringCount = d.offeringIndexes.length;
    d.arcNeeded = d.vendorCount * LAYOUT.buildingArcSpacing;
    // Radius of the sub-spiral that holds this many buildings.
    const walker = makeSpiralWalker(0, LAYOUT.districtB, Math.max(d.arcNeeded, 1));
    const end = walker.pointAt(d.arcNeeded);
    d.radius = r3(Math.hypot(end.x, end.z) + LAYOUT.roadHalfWidth + 26 + 8);
  }

  /* ---- layout: world spiral placement of district centres ---- */
  const totalWorldArc = districts.reduce((sum, d) => sum + 2 * d.radius + LAYOUT.districtGap, 0) + 400;
  const world = makeSpiralWalker(LAYOUT.worldA, LAYOUT.worldB, totalWorldArc);
  let cursor = 0;
  const boulevardPts = [];
  districts.forEach((d, di) => {
    const centreArc = cursor + d.radius;
    const c = world.pointAt(centreArc);
    d.center = { x: r3(c.x), z: r3(c.z) };
    d.centreArc = r3(centreArc);
    d.orientation = r3(di * LAYOUT.goldenAngle);
    cursor += 2 * d.radius + LAYOUT.districtGap;
    d._walker = makeSpiralWalker(0, LAYOUT.districtB, Math.max(d.arcNeeded, 1));
  });
  for (let s = 0; s <= cursor; s += LAYOUT.roadSampleEvery) {
    const p = world.pointAt(s);
    boulevardPts.push([r3(p.x), r3(p.z)]);
  }
  const worldExtent = Math.max(...districts.map((d) => Math.hypot(d.center.x, d.center.z) + d.radius));

  /* ---- layout: buildings on each district sub-spiral ---- */
  const cosO = (d) => Math.cos(d.orientation), sinO = (d) => Math.sin(d.orientation);
  for (const d of districts) {
    const road = [];
    for (let s = 0; s <= d.arcNeeded; s += LAYOUT.roadSampleEvery) {
      const p = d._walker.pointAt(s);
      const wx = d.center.x + p.x * cosO(d) - p.z * sinO(d);
      const wz = d.center.z + p.x * sinO(d) + p.z * cosO(d);
      road.push([r3(wx), r3(wz)]);
    }
    d.road = road;
    d.gate = road.length ? { x: road[0][0], z: road[0][1] } : { x: d.center.x, z: d.center.z };
    d.vendors.map((vid) => vendors.find((v) => v.id === vid)).forEach((v, j) => {
      const s = (j + 0.5) * LAYOUT.buildingArcSpacing;
      const p = d._walker.pointAt(s);
      // Local tangent and left-hand normal.
      let nx = -p.tz, nz = p.tx;
      const side = j % 2 === 0 ? 1 : -1;
      const size = buildingSize(v.offeringCount);
      const off = LAYOUT.roadHalfWidth + size.d / 2 + LAYOUT.lotClearance;
      const lx = p.x + nx * side * off, lz = p.z + nz * side * off;
      const wx = d.center.x + lx * cosO(d) - lz * sinO(d);
      const wz = d.center.z + lx * sinO(d) + lz * cosO(d);
      // Facing: from the building back toward the road, rotated to world space.
      const fLocal = { x: -nx * side, z: -nz * side };
      const fwx = fLocal.x * cosO(d) - fLocal.z * sinO(d);
      const fwz = fLocal.x * sinO(d) + fLocal.z * cosO(d);
      v.position = { x: r3(wx), z: r3(wz) };
      v.rotationY = r3(Math.atan2(fwx, fwz));
      v.size = size;
    });
    delete d._walker;
    delete d.offeringIndexes;
  }
  for (const v of vendors) delete v._firstIndex;

  const catalog = {
    meta: {
      snapshotOf: 'forks.json',
      layoutVersion: LAYOUT.version,
      offerings: offerings.length,
      vendors: vendors.length,
      districts: districts.length,
      rooms: offerings.length,
      builds: Object.keys(builds).length,
      worldRadius: r3(worldExtent),
      constants: LAYOUT,
    },
    spawn: { x: 24, z: 0, lookAt: { x: 160, z: 0 } },
    roads: { boulevard: boulevardPts },
    districts,
    vendors,
    builds,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 1) + '\n');
  console.log(`wrote ${OUT}`);
  console.log(`offerings=${catalog.meta.offerings} vendors=${catalog.meta.vendors} districts=${catalog.meta.districts} worldRadius=${catalog.meta.worldRadius}`);
  const researched = vendors.filter((v) => v.brand.source === 'researched').length;
  console.log(`brand palettes: researched=${researched} default=${vendors.length - researched}`);
  const lots = vendors.filter((v) => v.kind === 'lot');
  console.log(`empty lots=${lots.length} (${lots.map((v) => v.name).join(', ')})`);
  const notInTree = districts.filter((d) => !d.inGroupsTree).map((d) => d.id);
  console.log(`districts not in groups tree=${notInTree.length} (${notInTree.join(', ')})`);
  const roomsWithBuild = offerings.filter((o) => o.room.buildGroup).length;
  console.log(`rooms=${offerings.length} rooms with a source build=${roomsWithBuild} rooms without (unclassified)=${offerings.length - roomsWithBuild}`);
  console.log(`build records=${Object.keys(builds).length}`);
}

if (require.main === module) main();
module.exports = { BRAND_SEEDS, FEDERAL_FINISH, slugifyCategory, tierKeyOf, archetypeFor, forkIdOf, extractCli, extractHttp, extractControls };
