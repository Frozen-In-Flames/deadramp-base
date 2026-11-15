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
  /* ---- Phase 4 brand research, tranche 3 (Nov 15, 2026) ----
   * The next 60 default vendors in registry order after Asana
   * Inc., researched one by one. 53 were established from a citable
   * public source (recorded per entry below) and are seeded here;
   * the other 7 stay on the federal default: the only Brandfetch
   * listings for Aurigo Software Technologies, Bizagi and
   * Cellebrite carry only Brandfetch's fallback palette (#d6964a,
   * #6bbaef, #000000), which contradicts each page's own branding
   * text, so none of the three is citable; the only Certivo listing
   * contradicts itself (its About section describes NameBright, a
   * domain registrar); Avature Federal Platform, Boundera and the
   * Center for Translational Data Science (CTDS) have no citable
   * source stating brand colors as hex values. Every value below
   * appears in its cited source, verified against the fetched page. */
  // Brandfetch brand page (Caribbean Green, White, Zeus): https://brandfetch.com/asato.ai
  'Asato Corporation': { primary: '#05d3a1', secondary: '#ffffff', accent: '#241f16' },
  // Brandfetch brand page (Stratos, Dodger Blue, Black): https://brandfetch.com/asksage.ai
  'Ask Sage, Inc.': { primary: '#000c50', secondary: '#3b82f6', accent: '#000000' },
  // Brandfetch brand page for ASSYST Inc. of Sterling, VA (its registry offering is
  // ComplySyncATO), palette stated in its FAQ (no color names listed): https://brandfetch.com/assyst.net
  'ASSYST': { primary: '#4b7737', secondary: '#ffffff', accent: '#081e3e' },
  // Brandfetch brand page (Selective Yellow, White, Pale Sky): https://brandfetch.com/atom-ai.com
  'AtomAI Solutions Inc.': { primary: '#fcb900', secondary: '#ffffff', accent: '#6c7984' },
  // Brandfetch brand page (Ming, Shark, Westar): https://brandfetch.com/atxdefense.com
  'ATX Defense': { primary: '#317873', secondary: '#2c2c2e', accent: '#e5e3dd' },
  // Brandfetch brand page for the Silo cloud browser, palette stated in its FAQ
  // (no color names listed): https://brandfetch.com/authentic8.com
  'Authentic8, Inc.': { primary: '#2e406f', secondary: '#6966ff', accent: '#67a671' },
  // Brandfetch brand page (Curious Blue, Black, White): https://brandfetch.com/automattic.com
  'Automattic, Inc.': { primary: '#3399cc', secondary: '#000000', accent: '#ffffff' },
  // Brandfetch brand page (Turquoise, White, Bunting): https://brandfetch.com/autorabit.com
  'AutoRABIT Holding, Inc.': { primary: '#33d6b3', secondary: '#ffffff', accent: '#111d3b' },
  // Avaya Federal Solutions carries the parent Avaya brand; Brandfetch brand page,
  // palette stated in its FAQ (no color names listed): https://brandfetch.com/avaya.com
  'Avaya Federal Solutions, Inc.': { primary: '#da291c', secondary: '#ffffff', accent: '#004e6c' },
  // Brandfetch brand page (Zest, Raw Sienna, Regal Blue): https://brandfetch.com/axiad.com
  'Axiad IDS Inc.': { primary: '#e0772f', secondary: '#d2854f', accent: '#004e72' },
  // Axonius Federal Systems carries the parent Axonius brand; Brandfetch brand page
  // (Orange, White, Woodsmoke): https://brandfetch.com/axonius.com
  'Axonius Federal Systems': { primary: '#ff671e', secondary: '#ffffff', accent: '#16181d' },
  // Brandfetch brand page (Red Stage, Picton Blue, Congress Blue): https://brandfetch.com/aztecsoftware.com
  'Aztec Software': { primary: '#d36d00', secondary: '#4bc5eb', accent: '#02467f' },
  // Brandfetch brand page (Supernova, White, Woodsmoke): https://brandfetch.com/bamboohealth.com
  'Bamboo Health, Inc.': { primary: '#ffd10d', secondary: '#ffffff', accent: '#18181e' },
  // Brandfetch brand page (Malachite, Snow Drift, Black): https://brandfetch.com/baseten.co
  'Baseten Labs, Inc.': { primary: '#19e76e', secondary: '#f5f8f5', accent: '#000000' },
  // Beam Up Ltd trades as Beam; Brandfetch brand page (Eclipse, Pearl Bush,
  // Dove Gray): https://brandfetch.com/beam.org
  'Beam Up Ltd': { primary: '#2e1616', secondary: '#ede7de', accent: '#707070' },
  // Brandfetch brand page (Science Blue, Catskill White, Black): https://brandfetch.com/bentley.com
  'Bentley Systems, Incorporated': { primary: '#0071e3', secondary: '#fbfcfd', accent: '#000000' },
  // Brandfetch brand page (Chartreuse Yellow, Black, Spring Wood): https://brandfetch.com/betterup.com
  'BetterUp, Inc.': { primary: '#ddff0d', secondary: '#000000', accent: '#f4f3e9' },
  // Brandfetch brand page (Flamingo, Apricot, Ultramarine): https://brandfetch.com/beyondtrust.com
  'BeyondTrust': { primary: '#f15822', secondary: '#ec9d7a', accent: '#1903a6' },
  // Brandfetch brand page (Blue Ribbon, White, Black): https://brandfetch.com/bizzdesign.com
  'Bizzdesign US': { primary: '#1659ff', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page, palette stated in its FAQ (White also listed;
  // no color names listed): https://brandfetch.com/blackboard.com
  'Blackboard': { primary: '#0b9f38', secondary: '#0154bc', accent: '#0a0a0a' },
  // Brandfetch brand page, palette stated in its FAQ (#343434 also listed;
  // no color names listed): https://brandfetch.com/blackline.com
  'BlackLine Systems, Inc.': { primary: '#ffc10e', secondary: '#007cad', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/blackohm.com
  'BlackOhm': { primary: '#d16737', secondary: '#1d1d1f', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/bland.com
  'Bland AI': { primary: '#1f3a6f', secondary: '#ffd168', accent: '#171717' },
  // Brandfetch brand page (Ebony, Whiskey, Black): https://brandfetch.com/bluescape.com
  'Bluescape': { primary: '#0c111d', secondary: '#d8a47b', accent: '#000000' },
  // BlueVoyant Government Services carries the parent BlueVoyant brand; Brandfetch
  // brand page (Blue Ribbon, Portage, Shamrock; Riptide and Cornflower Blue also
  // listed): https://brandfetch.com/bluevoyant.com
  'BlueVoyant Government Services': { primary: '#0659ff', secondary: '#868cf9', accent: '#2bbea0' },
  // BP Pulse carries the parent bp brand; Brandfetch brand page, palette stated in
  // its FAQ (White also listed; no color names listed): https://brandfetch.com/bp.com
  'BP Pulse': { primary: '#cbff00', secondary: '#027f00', accent: '#003600' },
  // Bridge Intelligence does business as AssetIntel, and its registry offering is
  // the AssetIntel Asset Management Suite; Brandfetch brand page (Denim, Picton
  // Blue, Cinnamon): https://brandfetch.com/assetintel.co
  'Bridge Intelligence LLC. dba AssetIntel': { primary: '#137ac0', secondary: '#3898ec', accent: '#833c00' },
  // Brandfetch brand page, palette stated in its FAQ (White also listed;
  // no color names listed): https://brandfetch.com/broadinstitute.org
  'Broad Institute, Inc.': { primary: '#0f6db7', secondary: '#edf4f8', accent: '#000000' },
  // Brandfetch brand page (Blaze Orange, White, Mine Shaft): https://brandfetch.com/bugcrowd.com
  'Bugcrowd Inc.': { primary: '#ff6900', secondary: '#ffffff', accent: '#222222' },
  // Brandfetch brand page (Piper, White, Deep Cove): https://brandfetch.com/businessintegra.com
  'Business Integra Technology Solutions, Inc.': { primary: '#c56d27', secondary: '#ffffff', accent: '#05052d' },
  // Brandfetch brand page (Dodger Blue, White, Black): https://brandfetch.com/butterflynetwork.com
  'Butterfly Network Inc.': { primary: '#2779ff', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page (Purple Heart, Heliotrope, Ultramarine): https://brandfetch.com/cableteque.com
  'Cableteque Corp.': { primary: '#7030cf', secondary: '#a78bfa', accent: '#14078c' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/cahillswift.com
  'Cahill Swift, LLC': { primary: '#fe0034', secondary: '#b0a1da', accent: '#00305b' },
  // Caldera AI's registry offering is Mesa; Brandfetch brand page under the
  // company's Caldera PBC name describes that same Mesa platform, palette stated
  // in its FAQ (no color names listed): https://brandfetch.com/calderapbc.com
  'Caldera AI Inc.': { primary: '#55585f', secondary: '#ffffff', accent: '#12213d' },
  // Canon U.S.A. carries the parent Canon brand (the page names Canon U.S.A.
  // among Canon's subsidiaries); Brandfetch brand page, palette stated in its FAQ
  // (no color names listed): https://brandfetch.com/usa.canon.com
  'Canon U.S.A., Inc.': { primary: '#cc0100', secondary: '#000000', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/caveonix.com
  'Caveonix, Inc.': { primary: '#4745fe', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page (Steel Blue, Regent St Blue, Mexican Red): https://brandfetch.com/ceribell.com
  'Ceribell': { primary: '#427ebc', secondary: '#a2cfe2', accent: '#99262b' },
  // Brandfetch brand page (International Orange, Seashell Peach, Astronaut): https://brandfetch.com/chainalysis.com
  'Chainalysis': { primary: '#ff5300', secondary: '#fff7f0', accent: '#293a72' },
  // Brandfetch brand page (Flamingo, White, Atoll): https://brandfetch.com/chargepoint.com
  'ChargePoint, Inc.': { primary: '#e75516', secondary: '#ffffff', accent: '#0f588a' },
  // Brandfetch brand page (Blue Ribbon, Radical Red, Woodsmoke): https://brandfetch.com/chargie.com
  'Chargie, LLC': { primary: '#144bff', secondary: '#ff236c', accent: '#111415' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/checkpoint.com
  'Check Point Software Technologies, Inc.': { primary: '#d61a69', secondary: '#333333', accent: '#ffffff' },
  // Brandfetch brand page, claimed brand (Electric Violet, Deep Koamaru, Titan
  // White; White also listed): https://brandfetch.com/checkmarx.com
  'Checkmarx': { primary: '#6b34fc', secondary: '#121185', accent: '#efedff' },
  // Brandfetch brand page (Coral, Romantic, Wine Berry): https://brandfetch.com/chronus.com
  'Chronus LLC': { primary: '#ff744d', secondary: '#ffc8b9', accent: '#5d1842' },
  // Brandfetch brand page (Green Haze, White, Cyprus): https://brandfetch.com/circleci.com
  'CircleCI': { primary: '#049b4a', secondary: '#ffffff', accent: '#003740' },
  // Brandfetch brand page (Blue Zodiac, Mandys Pink, Dove Gray): https://brandfetch.com/cirrusmd.com
  'CirrusMD': { primary: '#101d42', secondary: '#f1cab4', accent: '#696969' },
  // Brandfetch brand page (Fuel Yellow, White, Astronaut): https://brandfetch.com/civisanalytics.com
  'Civis Analytics, Inc.': { primary: '#f1a137', secondary: '#ffffff', accent: '#215470' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/clarivate.com
  'Clarivate Analytics US LLC': { primary: '#5e33bf', secondary: '#f0f0eb', accent: '#000000' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/claroty.com
  'Claroty': { primary: '#e20ab7', secondary: '#fafafa', accent: '#000000' },
  // Cleartronic does business as ReadyOp Communications (the registry name
  // itself), and the page states ReadyOp is a platform from Cleartronic, Inc.;
  // Brandfetch brand page, palette stated in its FAQ (no color names
  // listed): https://brandfetch.com/readyop.com
  'Cleartronic, Inc. dba. ReadyOp Communications, Inc.': { primary: '#020381', secondary: '#8ed1fc', accent: '#32323a' },
  // Brandfetch brand page (San Marino, White, Prussian Blue): https://brandfetch.com/clearview.ai
  'Clearview AI, Inc.': { primary: '#4168b1', secondary: '#ffffff', accent: '#012745' },
  // Brandfetch brand page (Cello, Malibu, Ebony): https://brandfetch.com/cleat.ai
  'CLEATUS, Inc.': { primary: '#243665', secondary: '#60a5fa', accent: '#101828' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/cloudfitsoftware.com
  'CloudFit Software, LLC': { primary: '#233d93', secondary: '#fff9f9', accent: '#141d38' },
  // Brandfetch brand page (Azure Radiance, Anakiwa, Woodsmoke): https://brandfetch.com/cobblestonesoftware.com
  'CobbleStone Software': { primary: '#107dff', secondary: '#a9d0ff', accent: '#121619' },
  /* ---- Phase 4 brand research, tranche 4 (Nov 15, 2026) ----
   * The next 60 default vendors in registry order after
   * CobbleStone Software, researched one by one. 52 were
   * established from a citable public source (recorded per entry
   * below) and are seeded here; the other 8 stay on the federal
   * default: Cognition USG's only listing states exactly two
   * colors, so no third value is citable; the only ContinuumGRC
   * listing contradicts itself (its About section describes a
   * cookie-consent company, not the GRC audit vendor) and the
   * only Cyera listing's hex codes contradict its own branding
   * text (two near-identical lime greens against a stated
   * deep-purple primary palette); ComplianceAid, Consus
   * Industries, Coretsu, Creative Veteran Productions and
   * Distributed Solutions have no citable source stating brand
   * colors as hex values. Every value below appears in its
   * cited source, verified against the fetched page. */
  // Brandfetch brand page (Blue Ribbon, Midnight Blue, Persimmon): https://brandfetch.com/codesignal.com
  'CodeSignal, Inc.': { primary: '#1062fb', secondary: '#002570', accent: '#ff5b4a' },
  // Brandfetch brand page (Punch, White, Elephant): https://brandfetch.com/cofense.com
  'Cofense': { primary: '#d7282f', secondary: '#ffffff', accent: '#0e2538' },
  // Brandfetch brand page (Atlantis, Gallery, Cobalt): https://brandfetch.com/cohesity.com
  'Cohesity': { primary: '#96c73d', secondary: '#eeeeee', accent: '#0047bb' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/colabsoftware.com
  'CoLab': { primary: '#006ce0', secondary: '#ffffff', accent: '#020617' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/collabware.com
  'Collabware': { primary: '#bdb831', secondary: '#ffffff', accent: '#004d71' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/collibra.com
  'Collibra': { primary: '#72bf00', secondary: '#ffffff', accent: '#002b3f' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/cdslegal.com
  'Complete Discovery Source': { primary: '#fcc705', secondary: '#ffffff', accent: '#464646' },
  // Brandfetch brand page (Blue Zodiac, Pampas, Mirage): https://brandfetch.com/concoursetech.com
  'Concourse Tech Inc.': { primary: '#0e2d52', secondary: '#f6f6f1', accent: '#182328' },
  // Brandfetch brand page for SAP Concur, palette stated in its FAQ (Black also
  // listed; no color names listed): https://brandfetch.com/concur.com
  'Concur Technologies, Inc.': { primary: '#f0ab00', secondary: '#008fd3', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/confluent.io
  'Confluent': { primary: '#0156f9', secondary: '#000000', accent: '#ffffff' },
  // Brandfetch brand page (Gable Green, White, Gable Green): https://brandfetch.com/connectsecure.com
  'ConnectSecure LLC': { primary: '#12242b', secondary: '#ffffff', accent: '#193039' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/consensus.com
  'Consensus Cloud Solutions': { primary: '#7952ff', secondary: '#4aeadc', accent: '#007cba' },
  // Brandfetch brand page (Tawny Port, Viking, Deep Sea Green): https://brandfetch.com/contegix.com
  'Contegix': { primary: '#74275d', secondary: '#63bcdd', accent: '#0d4b6d' },
  // Brandfetch brand page (Congress Blue, Cerise Red, Black): https://brandfetch.com/contentguru.com
  'Content Guru': { primary: '#004d95', secondary: '#e83174', accent: '#000000' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/copado.com
  'Copado': { primary: '#00c3ef', secondary: '#fc5c50', accent: '#3d1665' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/coralogix.com
  'Coralogix Inc.': { primary: '#006cf8', secondary: '#f0f5fb', accent: '#050b25' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/coras.com
  'CORAS': { primary: '#00ccff', secondary: '#a6efff', accent: '#26262a' },
  // Brandfetch brand page (Eucalyptus, Aero Blue, International Klein Blue): https://brandfetch.com/corelight.com
  'Corelight': { primary: '#24b34c', secondary: '#befced', accent: '#063ba7' },
  // Brandfetch brand page (Tenn, Concrete, Blue Charcoal): https://brandfetch.com/cority.com
  'Cority Software Inc.': { primary: '#d65f00', secondary: '#f2f2f2', accent: '#011223' },
  // Cornerstone Information Systems is the Bloomington travel-technology company
  // at ciswired.com (cornerstone.com is Cornerstone Research, a different
  // company); Brandfetch brand page (Cornflower Blue, White, Stratos): https://brandfetch.com/ciswired.com
  'Cornerstone Information Systems': { primary: '#4f84f8', secondary: '#ffffff', accent: '#040059' },
  // Brandfetch brand page, palette stated in its FAQ (White also listed;
  // no color names listed): https://brandfetch.com/cornerstoneondemand.com
  'Cornerstone OnDemand': { primary: '#fa4616', secondary: '#2eccd3', accent: '#4a5568' },
  // Brandfetch brand page, palette stated in its FAQ (White also listed;
  // no color names listed): https://brandfetch.com/coupa.com
  'Coupa Software Inc': { primary: '#5ed5ff', secondary: '#1565c0', accent: '#081d4d' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/crestpt.com
  'CrestPoint Solutions, Inc': { primary: '#000000', secondary: '#a1cc3a', accent: '#ffffff' },
  // Brandfetch brand page (Blaze Orange, Robin's Egg Blue, Science Blue;
  // Alabaster and Daintree also listed): https://brandfetch.com/cribl.io
  'Cribl Inc.': { primary: '#ff6600', secondary: '#00cccc', accent: '#0b6cd9' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/curapatient.com
  'CuraPatient': { primary: '#f0923b', secondary: '#ffffff', accent: '#1461a5' },
  // Brandfetch brand page (Bay Leaf, Blizzard Blue, Black): https://brandfetch.com/cylogic.com
  'CyLogic': { primary: '#7eac8c', secondary: '#9dd7f0', accent: '#000000' },
  // Brandfetch brand page (Vermilion, Tangaroa, White): https://brandfetch.com/dailypay.com
  'DailyPay': { primary: '#ff4c00', secondary: '#03153a', accent: '#ffffff' },
  // Darktrace Federal carries the parent Darktrace brand; Brandfetch brand page,
  // palette stated in its FAQ (no color names listed; Darktrace's own Brand Hub
  // likewise names Black, Orange and White as its primary palette): https://brandfetch.com/darktrace.com
  'Darktrace Federal Inc.': { primary: '#f2582c', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page (Flamingo, White, Cod Gray): https://brandfetch.com/databank.com
  'DataBank Holdings': { primary: '#f35e2b', secondary: '#ffffff', accent: '#0b0b0b' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/datadoghq.com
  'Datadog, Inc.': { primary: '#632ca6', secondary: '#110617', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (Black also listed;
  // no color names listed): https://brandfetch.com/datarobot.com
  'DataRobot': { primary: '#81fba5', secondary: '#a6b0ff', accent: '#ffff54' },
  // Brandfetch brand page (Bright Turquoise, White, Jacksons Purple): https://brandfetch.com/datavant.com
  'Datavant': { primary: '#0dd9b8', secondary: '#ffffff', accent: '#211b94' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/dayforce.com
  'Dayforce': { primary: '#346fe7', secondary: '#080000', accent: '#ffffff' },
  // Brandfetch brand page (Royal Blue, My Sin, Black Pearl): https://brandfetch.com/decisionlens.com
  'Decision Lens Inc.': { primary: '#1d74ec', secondary: '#ffb526', accent: '#040d19' },
  // Brandfetch brand page (Tango, White, Fuscous Gray): https://brandfetch.com/cybersecgru.com
  'Defense Cybersecurity Group': { primary: '#f0810e', secondary: '#ffffff', accent: '#525150' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/dejero.com
  'Dejero Labs, Inc.': { primary: '#00468b', secondary: '#fcd34d', accent: '#000000' },
  // Deltek, Inc. carries the same Deltek brand seeded for Deltek - Replicon in
  // tranche 1; Brandfetch brand page, palette stated in its FAQ (no color names
  // listed): https://brandfetch.com/deltek.com
  'Deltek, Inc.': { primary: '#0063a3', secondary: '#ffffff', accent: '#72767b' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/devo.com
  'Devo': { primary: '#d6e80f', secondary: '#f3f3f3', accent: '#004c97' },
  // Brandfetch brand page (Meteor, Sisal, Red Berry): https://brandfetch.com/devresults.com
  'DevResults': { primary: '#d8820f', secondary: '#d6cdc1', accent: '#8b0000' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/dexcom.com
  'Dexcom Inc.': { primary: '#09b02c', secondary: '#161a1d', accent: '#ffffff' },
  // Brandfetch brand page (Dodger Blue, White, River Bed): https://brandfetch.com/digicert.com
  'DigiCert, Inc.': { primary: '#0f9dff', secondary: '#ffffff', accent: '#48565e' },
  // Brandfetch brand page (Lightning Yellow, Black, White): https://brandfetch.com/digital-science.com
  'Digital Science UK Limited': { primary: '#ffcc20', secondary: '#000000', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/digital.ai
  'Digital.ai': { primary: '#517934', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/diligent.com
  'Diligent, Inc.': { primary: '#ee312e', secondary: '#ffffff', accent: '#282e37' },
  // Brandfetch brand page (Medium Purple, White, Cod Gray): https://brandfetch.com/dispel.com
  'Dispel LLC': { primary: '#7554da', secondary: '#ffffff', accent: '#070606' },
  // The same Dispel company as the Dispel LLC entry above, under a second
  // registry name; Brandfetch brand page (Medium Purple, White, Cod Gray): https://brandfetch.com/dispel.com
  'Dispel, LLC': { primary: '#7554da', secondary: '#ffffff', accent: '#070606' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/dlhcorp.com
  'DLH Corporation': { primary: '#4054b2', secondary: '#ffffff', accent: '#a71444' },
  // Brandfetch brand page (Mariner, Catskill White, Hawaiian Tan): https://brandfetch.com/dmetrics.com
  'dMetrics': { primary: '#2f76c2', secondary: '#f5f7fa', accent: '#9e5218' },
  // Brandfetch brand page (Malibu, White, Outer Space): https://brandfetch.com/dnanexus.com
  'DNAnexus, Inc.': { primary: '#65c9f9', secondary: '#ffffff', accent: '#2c3339' },
  // Brandfetch brand page (Navy Blue, Violet, Hot Pink; Magenta and Lavender
  // also listed): https://brandfetch.com/docebo.com
  'Docebo': { primary: '#002b80', secondary: '#7e2ee9', accent: '#ff5dd8' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/docketscope.com
  'DocketScope, Inc.': { primary: '#0088ca', secondary: '#ffffff', accent: '#1b2a3c' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/dssinc.com
  'Document Storage Systems, Inc. (DSS, Inc.)': { primary: '#d6bb8e', secondary: '#a3dffa', accent: '#000000' },
  /* ---- Phase 4 brand research, tranche 5 (Nov 15, 2026) ----
   * The next 60 default vendors in registry order after
   * Document Storage Systems, Inc. (DSS, Inc.), researched one
   * by one. 52 were established from a citable public source
   * (recorded per entry below) and are seeded here; the other 8
   * stay on the federal default: Eleven Labs' only listing
   * states exactly two colors, so no third value is citable;
   * the only Filevine and Flock Safety listings' hex codes
   * contradict their own branding text (copper and mauve
   * against stated cool blue tones; a mustard-gold lead
   * against stated deep navy and teal) and the only Ground
   * Control listing contradicts itself (its header describes
   * an aerospace quality company, its About an incident
   * response company); Envisage Technologies' only listing
   * now sits under its acquirer Vector Solutions and Govini's
   * now describes Air, the successor brand it renamed to, so
   * neither palette is the vendor's own; Four BT and Get
   * A-Head have no citable source stating brand colors as hex
   * values. Every value below appears in its cited source,
   * verified against the fetched page. */
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/dossier.com
  'Dossier': { primary: '#243d51', secondary: '#8fcaf0', accent: '#64748b' },
  // Brandfetch brand page, claimed brand (Slate, Mist, Cobalt; Space and Dust also listed): https://brandfetch.com/drata.com
  'Drata': { primary: '#1c262b', secondary: '#f5f6f7', accent: '#2e4dff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/druva.com
  'Druva, Inc.': { primary: '#ff9900', secondary: '#699cee', accent: '#000833' },
  // Brandfetch brand page (Red, White, Astronaut): https://brandfetch.com/dtexsystems.com
  'DTEX Systems, Inc.': { primary: '#fe0000', secondary: '#ffffff', accent: '#232671' },
  // Economic Systems, Inc. does business as EconSys; Brandfetch brand page
  // (Cinnabar, Petite Orchid, Eden): https://brandfetch.com/econsys.com
  'Economic Systems': { primary: '#e63c25', secondary: '#da8e88', accent: '#0f445a' },
  // Brandfetch brand page (Mulberry, Lavender Rose, Black): https://brandfetch.com/egain.com
  'eGain Corporation': { primary: '#c942a6', secondary: '#ff90dc', accent: '#000000' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/egnyte.com
  'Egnyte': { primary: '#32bdb5', secondary: '#ffdb8f', accent: '#0d6e5f' },
  // Brandfetch brand page (Bondi Blue, Plum, White; Nile Blue also listed): https://brandfetch.com/eightfold.ai
  'Eightfold AI Inc.': { primary: '#008fbf', secondary: '#7e3a77', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/elekta.com
  'Elekta Solutions': { primary: '#2dccd3', secondary: '#8ff7ba', accent: '#006780' },
  // Brandfetch brand page for Elvo Health (the vendor's own site, per its
  // Marketplace listing), palette stated in its FAQ (no color names listed): https://brandfetch.com/elvohealth.com
  'Elvo': { primary: '#f7962e', secondary: '#021240', accent: '#5ebc6a' },
  // Brandfetch brand page (Cerulean, Midnight Blue, Maroon Flush; White and
  // Blue Zodiac also listed): https://brandfetch.com/emburse.com
  'Emburse': { primary: '#0097dc', secondary: '#002f6c', accent: '#b21f59' },
  // End To End Computing is now End To End Enterprise Solutions (E3S);
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/eecomputing.com
  'End To End Computing': { primary: '#f97316', secondary: '#ffffff', accent: '#16385c' },
  // Enel X North America carries the Enel X brand; Brandfetch brand page
  // (Trinidad, Anakiwa, Hawaiian Tan): https://brandfetch.com/enelx.com
  'Enel X North America': { primary: '#f33907', secondary: '#91fefc', accent: '#9c5119' },
  // Brandfetch brand page (Mindaro, Alabaster, Big Stone): https://brandfetch.com/energycap.com
  'EnergyCAP LLC.': { primary: '#caf880', secondary: '#fbfbfb', accent: '#162f3b' },
  // Brandfetch brand page (Torea Bay, Alice Blue, Haiti): https://brandfetch.com/entratus.ai
  'Entratus': { primary: '#0a3c9b', secondary: '#f0faff', accent: '#0f0d2b' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/eptura.com
  'Eptura, Inc': { primary: '#1b4bc5', secondary: '#f9fafc', accent: '#0d122e' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/ericsson.com
  'Ericsson': { primary: '#1174e6', secondary: '#0c0c0c', accent: '#ffffff' },
  // Brandfetch brand page (Trinidad, Goldenrod, Black): https://brandfetch.com/etherfax.net
  'ETHERFAX': { primary: '#e93301', secondary: '#ffcb70', accent: '#000000' },
  // Brandfetch brand page (Outrageous Orange, Black, White): https://brandfetch.com/everfox.com
  'Everfox': { primary: '#ff5b42', secondary: '#000000', accent: '#ffffff' },
  // Brandfetch brand page (Cornflower Blue, Morning Glory, Black): https://brandfetch.com/everlaw.com
  'Everlaw, Inc.': { primary: '#63b2e6', secondary: '#8fd2de', accent: '#000000' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/evidenceprime.com
  'Evidence Prime': { primary: '#70b9dd', secondary: '#6bbe6b', accent: '#003399' },
  // Brandfetch brand page (Copper, Jordy Blue, Chathams Blue): https://brandfetch.com/exlibrisgroup.com
  'Ex Libris': { primary: '#c57931', secondary: '#6bbaef', accent: '#1b4a78' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/exostar.com
  'Exostar': { primary: '#1e1c56', secondary: '#b5cefa', accent: '#0c4da2' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/exterro.com
  'Exterro, Inc.': { primary: '#f26c38', secondary: '#3e3e3c', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/extrahop.com
  'ExtraHop Networks': { primary: '#29a3a0', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/facilitygrid.com
  'Facility Grid, LLC': { primary: '#8db941', secondary: '#ffffff', accent: '#0e0c3c' },
  // Brandfetch brand page (Havelock Blue, Jordy Blue, Blue Zodiac): https://brandfetch.com/feith.com
  'Feith Sytems and Software, Inc.': { primary: '#408bdc', secondary: '#8bbef0', accent: '#0a1330' },
  // Brandfetch brand page, claimed brand (Dodger Blue, Electric Violet, Burning
  // Orange; Mountain Meadow and Red Orange also listed): https://brandfetch.com/figma.com
  'Figma': { primary: '#0d99ff', secondary: '#874fff', accent: '#ff7237' },
  // Brandfetch brand page, claimed brand (Primary Red, Mine Shaft, Hint of Red;
  // Alizarin Crimson also listed): https://brandfetch.com/files.com
  'Files.com': { primary: '#c11f32', secondary: '#222222', accent: '#fbf9f9' },
  // Brandfetch brand page (Cerulean, Selective Yellow, Cod Gray; White also listed): https://brandfetch.com/forescout.com
  'Forescout Technologies, Inc.': { primary: '#009dea', secondary: '#ffb400', accent: '#111111' },
  // Brandfetch brand page, palette stated in its FAQ (White also listed;
  // no color names listed): https://brandfetch.com/freshworks.com
  'Freshworks': { primary: '#8512e0', secondary: '#0000ee', accent: '#0b1320' },
  // Brandfetch brand page, claimed brand (Deep Blue, Scarlet, Dark Gray;
  // Sky Light and White also listed): https://brandfetch.com/fulcrumapp.com
  'Fulcrum': { primary: '#034c8c', secondary: '#eb1300', accent: '#414042' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/gallerysystems.com
  'Gallery Systems': { primary: '#d95726', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page for GDCII (the domain on the vendor's Marketplace
  // listing), palette stated in its FAQ (no color names listed): https://brandfetch.com/gdcii.com
  'GDC Integration, Inc.': { primary: '#6fb434', secondary: '#53accc', accent: '#333333' },
  // Brandfetch brand page for the General Services Administration (the
  // registry vendor; its offering is Login.gov), palette stated in its FAQ
  // (no color names listed): https://brandfetch.com/gsa.gov
  'General Services Administration': { primary: '#c8942b', secondary: '#c7a97b', accent: '#005ea2' },
  // Brandfetch brand page (Allports, Scooter, Black Pearl): https://brandfetch.com/geographicsolutions.com
  'Geographic Solutions Inc.': { primary: '#0069a4', secondary: '#46b8da', accent: '#061921' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/geotab.com
  'Geotab': { primary: '#00326d', secondary: '#ffffff', accent: '#666666' },
  // GetWellNetwork trades as Get Well; Brandfetch brand page (Valhalla,
  // Portage, Valhalla): https://brandfetch.com/getwellnetwork.com
  'GetWellNetwork': { primary: '#291758', secondary: '#9896f0', accent: '#221548' },
  // Brandfetch brand page (Ripe Lemon, Rajah, Red Beech): https://brandfetch.com/glassbeam.com
  'Glassbeam, Inc.': { primary: '#f2db0a', secondary: '#f7c67b', accent: '#732d00' },
  // Brandfetch brand page (Shakespeare, Di Serria, Limed Spruce): https://brandfetch.com/globaltelehealthservices.com
  'Global Telehealth Services, inc.': { primary: '#4597cb', secondary: '#dca559', accent: '#37474f' },
  // Brandfetch brand page (Jungle Green, Twilight Blue, Biscay): https://brandfetch.com/globality.com
  'Globality Inc': { primary: '#24b66f', secondary: '#f7ffff', accent: '#163760' },
  // Brandfetch brand page (Cerulean, Silver, Cod Gray): https://brandfetch.com/glytec.com
  'Glytec, LLC': { primary: '#00c0ff', secondary: '#cccccc', accent: '#151515' },
  // Brandfetch brand page (Blue Ribbon, Malibu, Mirage): https://brandfetch.com/gordian.com
  'Gordian': { primary: '#0067e7', secondary: '#8ed1fc', accent: '#1e293b' },
  // Brandfetch brand page (Blue Ribbon, Black White, Bright Gray): https://brandfetch.com/govdash.com
  'GovDash': { primary: '#024ff5', secondary: '#fffefa', accent: '#3c4250' },
  // Government Retirement & Benefits, Inc. is GRB Inc., as the page's own
  // About states in full; Brandfetch brand page (Monza, Alabaster, Mine
  // Shaft): https://brandfetch.com/grbinc.com
  'Government Retirement & Benefits, Inc.': { primary: '#c10021', secondary: '#f8f8f8', accent: '#222222' },
  // Brandfetch brand page (Brick Red, Cadet Blue, Rusty Nail): https://brandfetch.com/granicus.com
  'Granicus': { primary: '#cd364e', secondary: '#a9b8c3', accent: '#843d08' },
  // Brandfetch brand page (Electric Violet, Muddy Waters, Woodsmoke): https://brandfetch.com/groupize.com
  'Groupize, Inc.': { primary: '#9333ea', secondary: '#bc8461', accent: '#0f1115' },
  // H2O.AI for Government carries the parent H2O.ai brand; Brandfetch brand
  // page (Lightning Yellow, White, Cod Gray): https://brandfetch.com/h2o.ai
  'H2O.AI for Government': { primary: '#fec925', secondary: '#ffffff', accent: '#161616' },
  // Brandfetch brand page (Razzmatazz, White, Black): https://brandfetch.com/hackerone.com
  'HackerOne': { primary: '#ec1075', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page (Cerulean, White, Bunker): https://brandfetch.com/haivision.com
  'Haivision Systems, Inc.': { primary: '#00a3e0', secondary: '#ffffff', accent: '#101820' },
  // Brandfetch brand page, claimed brand (Sunshade, Seashell Peach, Midnight): https://brandfetch.com/halcyon.ai
  'Halcyon Tech, Inc.': { primary: '#ffac2f', secondary: '#fff6ed', accent: '#00182c' },
  // The vendor's Marketplace listing points at usehalo.com (Halo's ITSM
  // platform); Brandfetch brand page, claimed brand (Halo Blue, Navy,
  // Midnight; White and Teal also listed): https://brandfetch.com/usehalo.com
  'Halo': { primary: '#00ceff', secondary: '#002d5b', accent: '#051830' },
  /* ---- Phase 4 brand research, tranche 6 (Nov 15, 2026) ----
   * The next 60 default vendors in registry order after Halo,
   * researched one by one (Knox Systems, Inc. sits in this
   * registry range but was already decided in tranche 2 and is
   * not counted again). 53 were established from a citable
   * public source (recorded per entry below) and are seeded
   * here; the other 7 stay on the federal default: Human
   * Resources Technologies (HRTec) has no citable source
   * stating hex values (no Brandfetch page for its own domain
   * or its SurveyQwik product domain); the only ID.me and
   * Keyfactor listings' hex codes contradict their own
   * branding text (a stated navy-and-white foundation with
   * green highlights against listed mid-blue, gold and
   * charcoal; two greens and a violet against stated deep
   * indigo and navy with white); the only Innovest Systems
   * listing, at its own domain, now presents its acquirer
   * SS&C's Advent brand, and the only Innovative Discovery
   * listing, at its own former domain, now describes
   * Innovative Driven, the successor brand from its 2021
   * merger with Driven, so neither palette is the vendor's
   * own; the only Kovr.ai listing presents the parent
   * Fortreum's brand identity and palette under Fortreum's
   * name, not Kovr.ai's own; and the only Linear Orbit
   * listing (Linear) states exactly two colors, so no third
   * value is citable. Every value below appears in its cited
   * source, verified against the fetched page. */
  // Brandfetch brand page, claimed brand (Lochmara, Foam, Black Pearl): https://brandfetch.com/harness.io
  'Harness, Inc.': { primary: '#0677d4', secondary: '#effbfe', accent: '#07182b' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/hbhealthcaresafety.org
  'HB Healthcare Safety, SBC': { primary: '#b79a75', secondary: '#ffffff', accent: '#374a5e' },
  // Brandfetch brand page (Persian Green, White, Dove Gray): https://brandfetch.com/healthedge.com
  'HealthEdge Software, Inc.': { primary: '#02a990', secondary: '#ffffff', accent: '#666666' },
  // Brandfetch brand page (Chelsea Cucumber, White, Chathams Blue): https://brandfetch.com/healthverity.com
  'HealthVerity': { primary: '#72b456', secondary: '#ffffff', accent: '#144a65' },
  // Brandfetch brand page, palette stated in its FAQ (#f4f6f7 and #2b2d36 also
  // listed; no color names listed): https://brandfetch.com/hirevue.com
  'HireVue': { primary: '#e3203b', secondary: '#273553', accent: '#84b7ec' },
  // Brandfetch brand page, palette stated in its FAQ (White also listed;
  // no color names listed): https://brandfetch.com/hootsuite.com
  'Hootsuite': { primary: '#ff4c46', secondary: '#1e60c9', accent: '#012b3a' },
  // Huddle is offered by Ideagen, but the page is Huddle's own brand page at
  // its own domain; palette stated in its FAQ (#005784 also listed; no color
  // names listed): https://brandfetch.com/huddle.com
  'Huddle US': { primary: '#0089d0', secondary: '#7cc695', accent: '#f8f8f8' },
  // Brandfetch brand page (Flamingo, Danube, Mine Shaft): https://brandfetch.com/hypori.com
  'Hypori, Inc.': { primary: '#eb5f2a', secondary: '#6696d8', accent: '#333333' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/iboss.com
  'iBoss': { primary: '#059669', secondary: '#f2b756', accent: '#07090c' },
  // Brandfetch brand page (Copper Rust, White, Night Rider): https://brandfetch.com/icertis.com
  'Icertis Inc.': { primary: '#874451', secondary: '#ffffff', accent: '#221410' },
  // Brandfetch brand page (Shakespeare, Aquamarine, Blue Dianne): https://brandfetch.com/ideagen.com
  'Ideagen': { primary: '#45bbce', secondary: '#47fdfe', accent: '#22565e' },
  // Brandfetch brand page (Governor Bay, Goldenrod, Mine Shaft): https://brandfetch.com/ideascale.com
  'IdeaScale': { primary: '#384ec1', secondary: '#ffcb70', accent: '#333333' },
  // Brandfetch brand page (Orange, Black, White): https://brandfetch.com/illumio.com
  'Illumio, Inc.': { primary: '#fa6624', secondary: '#000000', accent: '#ffffff' },
  // Brandfetch brand page, claimed brand (Matisse, White, Vulcan): https://brandfetch.com/immuta.com
  'Immuta': { primary: '#e4b667', secondary: '#ffffff', accent: '#13151e' },
  // Brandfetch brand page (Blue Ribbon, White, Black): https://brandfetch.com/incode.com
  'Incode Technologies Inc.': { primary: '#006aff', secondary: '#ffffff', accent: '#000000' },
  // Brandfetch brand page (Azure Radiance, Downriver, Gull Gray): https://brandfetch.com/indirecttek.com
  'IndirectTek LLC': { primary: '#0084ff', secondary: '#0a1a3f', accent: '#94a3b8' },
  // Brandfetch brand page (Orange, Indigo, Blue Charcoal; White also listed): https://brandfetch.com/ineight.com
  'InEight, Inc.': { primary: '#ff651f', secondary: '#3860be', accent: '#000d1f' },
  // The page centers on the company's NetSfere platform; Brandfetch brand page
  // (Lochmara, White, Eastern Blue): https://brandfetch.com/infinite-convergence.com
  'Infinite Convergence Solutions, Inc.': { primary: '#008cd0', secondary: '#ffffff', accent: '#269abc' },
  // Brandfetch brand page, claimed brand (Lima, White, Regal Blue): https://brandfetch.com/infoblox.com
  'Infoblox': { primary: '#8cd21e', secondary: '#ffffff', accent: '#014369' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/infor.com
  'Infor': { primary: '#d20021', secondary: '#ffffff', accent: '#85702c' },
  // Brandfetch brand page, palette stated in its FAQ (White also listed;
  // no color names listed): https://brandfetch.com/informatica.com
  'Informatica LLC': { primary: '#e23500', secondary: '#00b4ff', accent: '#011e5b' },
  // Brandfetch brand page (Astral, Casper, Fiery Orange): https://brandfetch.com/infusionpoints.com
  'InfusionPoints': { primary: '#2f859b', secondary: '#b1c4d3', accent: '#b94a17' },
  // Brandfetch brand page (Anzac, Perano, Mariner): https://brandfetch.com/inteum.com
  'Inteum Company': { primary: '#e3ae4f', secondary: '#b0c8f6', accent: '#1e73be' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/intelliworxit.com
  'Intelliworx': { primary: '#00beff', secondary: '#ffffff', accent: '#001740' },
  // International Vending Management is IVM, Inc.; Brandfetch brand page,
  // palette stated in its FAQ (no color names listed): https://brandfetch.com/ivminc.com
  'International Vending Management, Inc.': { primary: '#ff6c2f', secondary: '#ffffff', accent: '#526271' },
  // Brandfetch brand page, palette stated in its FAQ (no color names
  // listed): https://brandfetch.com/intrepid-networks.com
  'Intrepid Networks LLC': { primary: '#ff652f', secondary: '#ffffff', accent: '#292929' },
  // Ipsos America carries the parent Ipsos brand; Brandfetch brand page,
  // palette stated in its FAQ (no color names listed): https://brandfetch.com/ipsos.com
  'Ipsos America, Inc.': { primary: '#14a19e', secondary: '#121b5a', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/ironcladapp.com
  'Ironclad Inc.': { primary: '#43d7a7', secondary: '#ffffff', accent: '#215d63' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/ironwifi.com
  'IronWiFi, LLC': { primary: '#004d99', secondary: '#0c2d4a', accent: '#ffffff' },
  // Brandfetch brand page, claimed brand (Green/1010, Brown/200, Green/400;
  // Green/800 also listed): https://brandfetch.com/island.io
  'Island': { primary: '#0a332c', secondary: '#f2ede8', accent: '#50e8a8' },
  // Brandfetch brand page (Alizarin Crimson, Jagged Ice, Outer Space): https://brandfetch.com/issio.com
  'Issio Solutions, Inc.': { primary: '#e41d3f', secondary: '#b6e3d4', accent: '#32373c' },
  // Brandfetch brand page for IT-CNP at its it-cnp.com domain (Endeavour,
  // Sandy brown, Big Stone): https://brandfetch.com/it-cnp.com
  'IT-CNP': { primary: '#0053a0', secondary: '#f4a45b', accent: '#152944' },
  // Itamar Medical now operates as ZOLL Itamar, its own name retained in the
  // lockup at its own domain; Brandfetch brand page (Persian Green, Havelock
  // Blue, Ebony): https://brandfetch.com/itamar-medical.com
  'Itamar Medical': { primary: '#00a099', secondary: '#4f9fd9', accent: '#111827' },
  // The page is titled for the parent Joint Commission, but its About
  // describes Joint Commission Resources (JCR) itself; Brandfetch brand page
  // (Saffron Mango, White, Biscay): https://brandfetch.com/jcrinc.com
  'Joint Commission Resources': { primary: '#fbc24f', secondary: '#ffffff', accent: '#1f336b' },
  // Brandfetch brand page (Allports, Stratos, White): https://brandfetch.com/judi.health
  'Judi Health™': { primary: '#026aa2', secondary: '#00003f', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/juniper.net
  'Juniper Networks': { primary: '#448500', secondary: '#000000', accent: '#ffffff' },
  // Brandfetch brand page (Bright Turquoise, White, Tangaroa): https://brandfetch.com/jupiterone.com
  'JupiterOne, Inc.': { primary: '#03e7bb', secondary: '#ffffff', accent: '#041e42' },
  // Brandfetch brand page (Crimson, White, Woodsmoke): https://brandfetch.com/juvare.com
  'Juvare, LLC': { primary: '#ce0e2e', secondary: '#ffffff', accent: '#101214' },
  // Brandfetch brand page (Red Ribbon, Danube, Shark): https://brandfetch.com/kahua.com
  'Kahua, Inc.': { primary: '#e70033', secondary: '#4d8dcf', accent: '#232328' },
  // Brandfetch brand page (Saffron, Danube, Blue Zodiac): https://brandfetch.com/kaseware.com
  'Kaseware, Inc': { primary: '#f2af35', secondary: '#769fd6', accent: '#0c1f39' },
  // Brandfetch brand page (Casal, White, Prussian Blue): https://brandfetch.com/koniag-gs.com
  'Koniag Government Services': { primary: '#275766', secondary: '#ffffff', accent: '#003057' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/labarchives.com
  'LabArchives': { primary: '#2ec99b', secondary: '#ffffff', accent: '#152430' },
  // Laerdal Labs D.C. carries the parent Laerdal Medical brand; Brandfetch
  // brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/laerdal.com
  'Laerdal Labs D.C.': { primary: '#2e7fa1', secondary: '#353535', accent: '#ffffff' },
  // Brandfetch brand page (Blue Lagoon, Alabaster, Teal): https://brandfetch.com/lastwall.com
  'Lastwall Corp': { primary: '#007681', secondary: '#fcfcfc', accent: '#007680' },
  // Brandfetch brand page, claimed brand (Dodger Blue, Cod Gray, White): https://brandfetch.com/launchdarkly.com
  'LaunchDarkly': { primary: '#405bff', secondary: '#191919', accent: '#ffffff' },
  // Brandfetch brand page (Cobalt, White, Outer Space): https://brandfetch.com/lcptracker.com
  'LCptracker Inc': { primary: '#024dad', secondary: '#ffffff', accent: '#32373c' },
  // Brandfetch brand page (Congress Blue, Mine Shaft, Tango; Catskill White
  // also listed): https://brandfetch.com/leadershipconnect.io
  'Leadership Connect, Inc.': { primary: '#00468b', secondary: '#333333', accent: '#f47920' },
  // Brandfetch brand page, claimed brand (Azure, Plum, Midnight; Bright Sky
  // also listed): https://brandfetch.com/levelaccess.com
  'Level Access': { primary: '#1f2df5', secondary: '#7a34f2', accent: '#1a073c' },
  // Brandfetch brand page (Azure Radiance, Sulu, Navy Blue): https://brandfetch.com/levelblue.com
  'LevelBlue': { primary: '#00aaff', secondary: '#9cef69', accent: '#00007b' },
  // Brandfetch brand page (Royal Blue, Dodger Blue, Woodsmoke): https://brandfetch.com/lifebit.ai
  'Lifebit Biotech': { primary: '#1a6fe8', secondary: '#3791f5', accent: '#07080a' },
  // Brandfetch brand page (Blue Ribbon, White, Downriver): https://brandfetch.com/liferay.com
  'Liferay, Inc.': { primary: '#0b5fff', secondary: '#ffffff', accent: '#072252' },
  // Litmas, Inc. is the legal name behind Litmas AI, per the company's own
  // privacy policy; Brandfetch brand page (Black Rock, Gray, White): https://brandfetch.com/litmas.ai
  'Litmas, Inc.': { primary: '#100429', secondary: '#888888', accent: '#ffffff' },
  // Brandfetch brand page (Flamingo, White, Eden): https://brandfetch.com/lmi.org
  'LMI Solutions': { primary: '#f7612b', secondary: '#ffffff', accent: '#104e55' },
  /* ---- Phase 4 brand research, tranche 7 (Nov 15, 2026) ----
   * The next 60 default vendors in registry order after LMI
   * Solutions, researched one by one. 53 were established
   * from a citable public source (recorded per entry below)
   * and are seeded here; the other 7 stay on the federal
   * default: Magenta (an AI platform for regulated
   * manufacturing per the registry) could not be identified
   * as a company after repeated targeted searches, so no
   * citable source exists; Meterbox Inc. is confirmed at
   * meterbox.ai but has no Brandfetch page and no other
   * source stating hex values; the only MicroStrategy
   * listing is internally contradictory (its FAQ branding
   * text describes the successor Strategy identity, a black
   * logotype with an orange emblem, while its listed hexes
   * are the legacy MicroStrategy palette with no orange or
   * black) and the vendor now trades as Strategy, its name
   * not retained; mLINQS and Movius Interactive Corporation
   * have no Brandfetch page for their own domains and no
   * other citable hex source; and Neuramill, Inc. and
   * Ocasio Convergence Holdings LLC could not be identified
   * as companies after targeted searches (search results
   * return unrelated entities), so no citable source exists.
   * Every value below appears in its cited source, verified
   * against the fetched page. */
  // Brandfetch brand page (Deep Cove, Golden Fizz, Comet): https://brandfetch.com/logicmonitor.com
  'LogicMonitor': { primary: '#060f4b', secondary: '#e8ff26', accent: '#525c75' },
  // Brandfetch brand page (Sushi, Malibu, Deep Cove): https://brandfetch.com/longevityconsulting.com
  'Longevity Consulting': { primary: '#8bc53f', secondary: '#4cc6ff', accent: '#071f40' },
  // Brandfetch brand page (Electric Lime, Porcelain, Te Papa Green): https://brandfetch.com/lookout.com
  'Lookout, Inc.': { primary: '#c8ff00', secondary: '#f5f6f7', accent: '#1e3239' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/lspedia.com
  'LSPedia': { primary: '#bb3b9e', secondary: '#ffffff', accent: '#0d1c3f' },
  // Brandfetch brand page, claimed brand (Shark, Denim, Red Violet;
  // Cornflower Blue #635dff and White also listed): https://brandfetch.com/lucid.co
  'Lucid Software, Inc.': { primary: '#282c33', secondary: '#1071e5', accent: '#d916a8' },
  // Brandfetch brand page (Carnation, White, Firefly): https://brandfetch.com/lumen.com
  'Lumen': { primary: '#f95e4a', secondary: '#ffffff', accent: '#0f3133' },
  // Brandfetch brand page (Emperor, Prussian Blue, White): https://brandfetch.com/mcdean.com
  'M.C. Dean, Inc.': { primary: '#525252', secondary: '#001e54', accent: '#ffffff' },
  // Brandfetch brand page (Blue Ribbon, White, Resolution Blue): https://brandfetch.com/magnetforensics.com
  'Magnet Forensics': { primary: '#0050f0', secondary: '#ffffff', accent: '#001b78' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/maintainx.com
  'MaintainX': { primary: '#246cff', secondary: '#043fba', accent: '#68c1fd' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/manh.com
  'Manhattan Associates, Inc.': { primary: '#0fe677', secondary: '#ffffff', accent: '#083332' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/maplarge.com
  'MapLarge Inc.': { primary: '#0c73a3', secondary: '#ffffff', accent: '#2c3034' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/mari.com
  'MARi, LLC': { primary: '#4a3b96', secondary: '#5d5fef', accent: '#0f0f2e' },
  // Brandfetch brand page (Torea Bay, Steel Blue, Blue Charcoal): https://brandfetch.com/mark43.com
  'Mark43, Inc.': { primary: '#15378e', secondary: '#4680c2', accent: '#000a12' },
  // Brandfetch brand page (Boston Blue, Gull Gray, Daintree): https://brandfetch.com/mastercontrol.com
  'MasterControl': { primary: '#3b94a3', secondary: '#97a8af', accent: '#002a3a' },
  // Brandfetch brand page (Watercourse, White, Watercourse): https://brandfetch.com/mathematica.org
  'Mathematica Inc.': { primary: '#046b5c', secondary: '#ffffff', accent: '#055c59' },
  // Brandfetch brand page (Danube, Olive, White): https://brandfetch.com/mcgenergy.com
  'MCG Energy Solutions, LLC': { primary: '#7ea6d7', secondary: '#999700', accent: '#ffffff' },
  // Brandfetch brand page (Manatee, Malibu, Orient): https://brandfetch.com/mdrc.org
  'MDRC': { primary: '#949598', secondary: '#6fd4fb', accent: '#00558c' },
  // Medallia's own published brand guidelines (Slate 950, Frost, Flash 400;
  // Indigo also listed). The Brandfetch listing's codes match nothing in
  // Medallia's own palette and were rejected: https://www.medallia.com/brand/
  'Medallia Inc.': { primary: '#0d0f10', secondary: '#ffffff', accent: '#c8ff00' },
  // Same company and brand as Medallia Inc. above (duplicate registry
  // entry); Medallia's own published brand guidelines: https://www.medallia.com/brand/
  'Medallia, Inc.': { primary: '#0d0f10', secondary: '#ffffff', accent: '#c8ff00' },
  // MediaLab Solutions now trades as Vastian; the palette is Vastian's at
  // the vendor's own medialab.com domain and its registry offering is
  // "Vastian (MediaLab by Vastian)"; Brandfetch brand page (Coconut Cream,
  // Mandys Pink, Rose Bud Cherry): https://brandfetch.com/medialab.com
  'MediaLab Solutions LLC': { primary: '#f8edd4', secondary: '#f4bfad', accent: '#6f0a4b' },
  // Same company and domain family as MediaLab Solutions LLC above;
  // Vastian palette at the vendor's own domain: https://brandfetch.com/medialab.com
  'MediaLab, Inc.': { primary: '#f8edd4', secondary: '#f4bfad', accent: '#6f0a4b' },
  // Brandfetch brand page (Curious Blue, White, Orient): https://brandfetch.com/melissa.com
  'Melissa': { primary: '#1da5de', secondary: '#ffffff', accent: '#026780' },
  // Brandfetch brand page (Pumpkin, White, Honey Flower): https://brandfetch.com/menlosecurity.com
  'Menlo Security': { primary: '#ff6f15', secondary: '#ffffff', accent: '#4a1a65' },
  // Brandfetch brand page, palette stated in its FAQ (no color names
  // listed). The accent #000000 is a single value shared with the Brandfetch
  // fallback palette, but the fallback trio itself is absent and the page
  // describes this vendor's own LMS company: https://brandfetch.com/meridianks.com
  'Meridian Knowledge Solutions, LLC': { primary: '#0693e3', secondary: '#5eabea', accent: '#000000' },
  // The page presents Merlin Cyber, the vendor's own current brand at its
  // own domain; Brandfetch brand page (Neon Carrot, White, Midnight
  // Blue): https://brandfetch.com/merlin-intl.com
  'Merlin International': { primary: '#ff9933', secondary: '#ffffff', accent: '#00326d' },
  // Brandfetch brand page (Sorrell Brown, Cararra, Cod Gray): https://brandfetch.com/mimic.com
  'Mimic Networks, Inc.': { primary: '#d1b792', secondary: '#fafaf8', accent: '#141414' },
  // Brandfetch brand page (East Bay, Dodger Blue, Mine Shaft); the page
  // header names GovPoint Cloud Services, the registry offering: https://brandfetch.com/mis-sciences.com
  'MIS Sciences Corporation': { primary: '#3d5975', secondary: '#597dff', accent: '#333333' },
  // Moodle US LLC carries the parent Moodle brand; Moodle's own Global
  // Brand Guidelines, Colours page (Moodle Orange, Moodle Blue, Moodle
  // Black). The Brandfetch listing omits orange, the brand's identity
  // color, entirely and was rejected: https://moodle.com/wp-content/uploads/2025/07/Moodle-Global-Brand-Guidelines.pdf
  'Moodle US LLC': { primary: '#f98012', secondary: '#194866', accent: '#282828' },
  // Brandfetch brand page (Electric Violet, Dodger Blue, Gallery; Cod Gray
  // #0a0a0a also listed): https://brandfetch.com/moveworks.com
  'Moveworks': { primary: '#8300e6', secondary: '#2e9bff', accent: '#eeeeee' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/msmgroupinc.com
  'MSM Group, Inc.': { primary: '#00529b', secondary: '#ffffff', accent: '#96999b' },
  // Brandfetch brand page (Zest, Peach Orange, Vesuvius): https://brandfetch.com/mybusinessmatches.com
  'My Business Matches': { primary: '#de7718', secondary: '#fecf9b', accent: '#af510b' },
  // Brandfetch brand page (Deep Teal, Algae Green, Firefly); the page
  // header and tags are the GRC company's own (its About text is generic
  // boilerplate): https://brandfetch.com/mycroft.io
  'Mycroft Technologies Inc': { primary: '#002b2a', secondary: '#88e2b5', accent: '#0f2d2c' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/myevaluations.com
  'MyEvaluations.com Inc.': { primary: '#087fb3', secondary: '#e1f4ff', accent: '#003c70' },
  // BitRip is Nastro Technologies' own product brand (the registry
  // offering) at its own domain; Brandfetch brand page (Outer Space,
  // Olivine, Biscay): https://brandfetch.com/bitrip.com
  'Nastro Technologies, Inc.': { primary: '#32373c', secondary: '#97b766', accent: '#183964' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/navigatorcre.com
  'NavigatorCRE': { primary: '#fe0000', secondary: '#ffffff', accent: '#93552c' },
  // NCR Government is NCR Voyix's government arm and its registry offering
  // is "NCR VOYIX GOVERNMENT CLOUD"; NCR Voyix Brandfetch brand page,
  // palette stated in its FAQ (no color names listed): https://brandfetch.com/ncrvoyix.com
  'NCR Government, LLC': { primary: '#b280ff', secondary: '#000000', accent: '#ffffff' },
  // Brandfetch brand page (Shakespeare, Black White, Oracle): https://brandfetch.com/neogov.com
  'NEOGOV': { primary: '#3aaecd', secondary: '#fffffe', accent: '#3b6379' },
  // Brandfetch brand page (Tory Blue, Cinnabar, Salem): https://brandfetch.com/net-inspect.com
  'Net-Inspect LLC': { primary: '#1361ab', secondary: '#e43b3b', accent: '#089e4b' },
  // Brandfetch brand page, palette stated in its FAQ (five values listed;
  // Black and White also listed; no color names listed): https://brandfetch.com/netapp.com
  'NetApp': { primary: '#831784', secondary: '#351f9c', accent: '#00ddf4' },
  // Brandfetch brand page (Abbey, Danube, Sherpa Blue); the page describes
  // NetComm's own Beacon platform, the registry offering: https://brandfetch.com/netcomm.net
  'NetComm': { primary: '#4d5154', secondary: '#5e9ed6', accent: '#003d4d' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/netdocuments.com
  'NetDocuments Software, Inc.': { primary: '#276de7', secondary: '#9896f0', accent: '#000acf' },
  // Brandfetch brand page (Flush Orange, Bubbles, Downriver): https://brandfetch.com/netskope.com
  'Netskope, Inc.': { primary: '#ff8200', secondary: '#e8fcff', accent: '#081a59' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/newrelic.com
  'New Relic': { primary: '#1ce783', secondary: '#1d252c', accent: '#ffffff' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/nexgenam.com
  'NEXGEN Asset Management': { primary: '#5b5e66', secondary: '#f6f6f6', accent: '#302020' },
  // Brandfetch brand page (Denim, Periwinkle Gray, Mule Fawn): https://brandfetch.com/nextgenid.com
  'NextgenID, Inc.': { primary: '#1468ea', secondary: '#bccbe1', accent: '#8e572e' },
  // Brandfetch brand page (Tory Blue, Dodger Blue, Midnight): https://brandfetch.com/nexthink.com
  'Nexthink': { primary: '#1046a8', secondary: '#3194f7', accent: '#011130' },
  // NICE CXone carries the NiCE brand (CXone is its product); NiCE
  // Brandfetch brand page, palette stated in its FAQ (White also listed;
  // no color names listed): https://brandfetch.com/nice.com
  'NICE CXone': { primary: '#3694fd', secondary: '#f2f0eb', accent: '#22212b' },
  // Brandfetch brand page (San Juan, Ziggurat, Black Russian): https://brandfetch.com/noblis.org
  'Noblis': { primary: '#2e5b78', secondary: '#b0cede', accent: '#000522' },
  // Brandfetch brand page (Tango, White, Jacarta): https://brandfetch.com/norc.org
  'NORC': { primary: '#ec712e', secondary: '#ffffff', accent: '#29246a' },
  // NormShield does business as Black Kite and its registry offering is
  // the Black Kite product; Black Kite Brandfetch brand page, claimed
  // brand (Emerald, White, Japanese Laurel): https://brandfetch.com/blackkite.com
  'NormShield, Inc. DBA Black Kite': { primary: '#3dcc77', secondary: '#ffffff', accent: '#007e0b' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/nozominetworks.com
  'Nozomi Networks Inc.': { primary: '#0093d2', secondary: '#ffffff', accent: '#494957' },
  // Brandfetch brand page, palette stated in its FAQ (no color names listed): https://brandfetch.com/nuance.com
  'Nuance': { primary: '#285ce6', secondary: '#b6c8f7', accent: '#141380' },
  // Brandfetch brand page (Blue Ribbon, Anakiwa, Ebony Clay): https://brandfetch.com/nucleussec.com
  'Nucleus Security, Inc': { primary: '#1070ff', secondary: '#9fc6ff', accent: '#1e2330' },
  // Tranche 8 (Nov 15, 2026): the next 60 default-palette vendors in registry
  // order after Ocasio Convergence Holdings LLC, from Ocient Inc. through
  // Quzara, LLC. 54 moved to researched. OneSpan Inc. leads the block: it was
  // fully verified in tranche 7 but sat one position past that tranche's
  // boundary, so it was left unseeded on the record there; its listing was
  // re-fetched and re-confirmed for this tranche before seeding. Stayed
  // default on the record: OnSolve LLC (its brandfetch.com/onsolve.com page
  // now presents acquirer Crisis24's brand: page titled Crisis24, palette
  // expressly 'The Crisis24 color palette' #ff4712/#d29350/#191919, About
  // says OnSolve is 'now part of the Crisis24 portfolio'; OnSolve's own
  // colors are not citable there); OpenAI (its claimed brandfetch.com/
  // openai.com listing states exactly two colors, #ffffff and #080808; no
  // third value citable and the accent is never invented); Optimal Labs
  // (company confirmed on the FedRAMP Marketplace, offering '9line', but no
  // company website or domain and no citable hex source found after targeted
  // searches); Power Settlements Consulting and Software, LLC (PSCS), a
  // subsidiary of Yes Energy, LLC (brandfetch.com/powersettlements.com is
  // titled 'Yes Energy' and its palette is expressly 'The Yes Energy color
  // palette' #68aec7/#ffffff/#3a3a3a under the parent's name and logos,
  // though the page's header and About describe Power Settlements itself;
  // the only citable palette at the vendor's own domain is the parent's,
  // presented as the parent's: tranche 6 Kovr.ai precedent); Pincus
  // Technologies Inc (company could not be identified to any citable source
  // after repeated targeted searches; registry offering 'Tarly Cowork' has
  // no public trace); PTC (brandfetch.com/ptc.com was fetched in full but
  // states no hex palette at all, and no other citable source for PTC Inc.'s
  // colors was found). Judgment calls recorded in the per-entry comments:
  // Ontario Systems seeded from Finvi, the vendor's own current brand (the
  // registry name itself carries 'd/b/a Finvi'); OwnBackup seeded from a
  // listing presenting 'Own', the company's own renamed identity, whose
  // About is about OwnBackup itself; Optum Serve seeded from the Optum
  // parent brand it carries as Optum's federal division; Pearson VUE seeded
  // from a listing titled for parent Pearson whose About describes Pearson
  // VUE itself, VUE carrying the parent brand. Perceptyx and Qualtrics were
  // seeded on their named/listed swatch data despite FAQ prose tension,
  // recorded per entry (tranche 7 Moveworks precedent). Six seeds carry
  // #000000 as a single fallback-trio member with named, unique,
  // identity-consistent swatches (Ocient accent, Onspring accent, Open
  // Access Technology International accent, OpenWater accent, Phenom accent,
  // PTFS/Liblime accent): flagged per entry, tranche 5 Ex Libris precedent;
  // the fallback trio itself appears in none.
  // Source: brandfetch.com/onespan.com brand page, named swatches Turquoise /
  // Black Haze / Blue Lagoon; page identity matches (digital security and
  // e-signature; registry offering is the OneSpan Sign service). Verified in
  // tranche 7 and re-fetched and re-confirmed for tranche 8.
  'OneSpan Inc.': { primary: '#4cdbcb', secondary: '#f0f2f2', accent: '#00788c' },
  // Source: brandfetch.com/ocient.com brand page, named swatches Conifer /
  // Picton Blue / Black; header names OcientAIQ, the registry offering.
  // Accent #000000 is a single fallback-trio member; swatches named, unique,
  // identity-consistent (Ex Libris precedent).
  'Ocient Inc.': { primary: '#a2da59', secondary: '#1ab7ea', accent: '#000000' },
  // Source: brandfetch.com/oclc.org brand page, named swatches Matisse /
  // Black Haze / Limed Spruce; About names WorldShare Management Services,
  // the registry offering.
  'OCLC Incorporated': { primary: '#2178b4', secondary: '#f6f7f7', accent: '#333f48' },
  // Source: brandfetch.com/omnissa.com brand page (claimed brand), named
  // swatches Navy / Light cool grey / White; fallback lettermark icon only.
  'Omnissa': { primary: '#001e60', secondary: '#f5f6fb', accent: '#ffffff' },
  // Source: brandfetch.com/onestream.com brand page, named swatches Purple
  // Heart / Green Haze / Chilean Fire (Pink Salmon #ff8fb4 and Dodger Blue
  // #5564ff also listed).
  'OneStream Software': { primary: '#6e26c1', secondary: '#00985b', accent: '#f67d02' },
  // Source: brandfetch.com/onspring.com brand page, named swatches Blue Whale
  // / Portage / Black. Accent #000000 is a single fallback-trio member;
  // swatches named, unique, identity-consistent (Ex Libris precedent).
  'Onspring Technologies, LLC': { primary: '#05254a', secondary: '#9896f0', accent: '#000000' },
  // Source: brandfetch.com/finvi.com brand page, named swatches Atlantis /
  // Malibu / Mine Shaft. Judgment: the registry name itself carries 'd/b/a
  // Finvi'; Finvi is the vendor's own current brand at its own domain (page
  // founded 1980, Ontario Systems' founding; collections and revenue-cycle
  // business matches). Fallback lettermark icon only.
  'Ontario Systems, LLC d/b/a Finvi': { primary: '#99ca3c', secondary: '#8ed1fc', accent: '#202020' },
  // Source: brandfetch.com/ontic.co brand page, named swatches Tango / Zircon
  // / Deep Sapphire.
  'Ontic Technologies': { primary: '#e96822', secondary: '#f1f7ff', accent: '#0a376d' },
  // Source: brandfetch.com/oati.com brand page, palette stated in its FAQ (no
  // color names listed). Accent #000000 is a single fallback-trio member;
  // values unique and identity-consistent (Ex Libris precedent).
  'Open Access Technology International, Inc.': { primary: '#cf3339', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/openclinica.com brand page, palette stated in its
  // FAQ (no color names listed).
  'OpenClinica LLC': { primary: '#cf6261', secondary: '#eef6fd', accent: '#112337' },
  // Source: brandfetch.com/getopenwater.com brand page, palette stated in its
  // FAQ (no color names listed). Accent #000000 is a single fallback-trio
  // member; values unique and identity-consistent (Ex Libris precedent).
  'OpenWater Software LLC': { primary: '#a1e1fb', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/orbussoftware.com brand page, named swatches San
  // Juan / Viking / Bunting; About names OrbusInfinity, the registry
  // offering family.
  'Orbus Software': { primary: '#2e4674', secondary: '#5edac3', accent: '#151e47' },
  // Source: brandfetch.com/orca.security brand page, named swatches Stratos /
  // Crusta / Congress Blue.
  'Orca Security': { primary: '#020445', secondary: '#ff7f2b', accent: '#004085' },
  // Source: brandfetch.com/ownbackup.com brand page, named swatches Yellow
  // Orange / Alice Blue / Shark. Judgment: the page presents 'Own', the
  // company's own renamed identity (OwnBackup renamed itself Own); the About
  // section is about OwnBackup itself and the registry offering is 'Own
  // Government Cloud'. Renamed-vendor retained-identity precedent (tranche 6
  // Itamar Medical, tranche 7 MediaLab/Vastian), not an acquirer.
  'OwnBackup': { primary: '#ffbe42', secondary: '#f0f7ff', accent: '#1d2327' },
  // Source: brandfetch.com/pagefreezer.com brand page, named swatches Sunglow
  // / Goldenrod / Genoa.
  'Pagefreezer Software Inc.': { primary: '#ffc72c', secondary: '#ffcb70', accent: '#115e67' },
  // Source: brandfetch.com/optum.com brand page (claimed brand), named
  // swatches Outrageous Orange / Resolution Blue / Humming Bird (Scorpion
  // #5a5a5a and Merino #fbf9f4 also listed). Judgment: Optum Serve is Optum's
  // federal division and carries the Optum brand; registry offering is
  // 'Optum Serve Federal Platform' (parent-brand precedents: tranche 2 Ipsos
  // America, USDA; tranche 5 NICE CXone).
  'Optum Serve': { primary: '#ff612b', secondary: '#002677', accent: '#d9f6fa' },
  // Source: brandfetch.com/pagerduty.com brand page, palette stated in its
  // FAQ (no color names listed); five values listed (#000000 and #ffffff
  // also), first three in listed order seeded. About names the PagerDuty
  // Operations Cloud, the registry offering.
  'PagerDuty': { primary: '#048a24', secondary: '#171817', accent: '#005a2f' },
  // Source: brandfetch.com/paperless-innovations.com brand page (the
  // hyphenated domain is the company's real one; brandfetch.com/
  // paperlessinnovations.com returns 404), palette stated in its FAQ (no
  // color names listed); About matches the GPC compliance automation
  // business behind the registry offering 'Actus'.
  'Paperless Innovations, Inc.': { primary: '#3ed8c6', secondary: '#ffffff', accent: '#49576d' },
  // Source: brandfetch.com/partos.ai brand page, named swatches Cod Gray /
  // Milano Red / Porcelain; About (aerospace and defense supply-chain AI,
  // Stanford Research Park, Palo Alto) matches the registry vendor,
  // identified independently through its USPTO trademark filing.
  'Partos Inc.': { primary: '#0e0e0e', secondary: '#d81703', accent: '#fcfdfd' },
  // Source: brandfetch.com/patlytics.com brand page, named swatches Lima /
  // Ecru White / Celtic.
  'Patlytics, Inc.': { primary: '#57dc2f', secondary: '#f5f0e7', accent: '#133020' },
  // Source: brandfetch.com/pdq.com brand page, named swatches Tall Poppy /
  // White / Tundora; fallback lettermark icon only.
  'PDQ': { primary: '#bd2426', secondary: '#ffffff', accent: '#404040' },
  // Source: brandfetch.com/pdri.com brand page, named swatches Blue Chill /
  // Mantis / Midnight; header and About name Palladium, the registry
  // offering; PDRI carries its own brand at its own domain.
  'PDRI by Pearson': { primary: '#0a80a3', secondary: '#8cc65e', accent: '#00233e' },
  // Source: brandfetch.com/pearsonvue.com brand page, palette stated in its
  // FAQ (no color names listed). Judgment: the page is titled 'Pearson' but
  // its About describes Pearson VUE itself; Pearson VUE carries the parent
  // Pearson brand.
  'Pearson VUE': { primary: '#007fa3', secondary: '#ffffff', accent: '#003057' },
  // Source: brandfetch.com/pega.com brand page, palette stated in its FAQ (no
  // color names listed).
  'Pegasystems': { primary: '#5f67b9', secondary: '#001f5f', accent: '#ffffff' },
  // Source: brandfetch.com/penielsolutions.com brand page, named swatches
  // Java / White / Cod Gray; About includes Records Management (registry
  // offering 'TransAccess GovCloud Records').
  'Peniel Solutions, LLC': { primary: '#1cc0c6', secondary: '#ffffff', accent: '#1c1c1c' },
  // Source: brandfetch.com/pepelwerk.com brand page, palette stated in its
  // FAQ (no color names listed).
  'Pepelwerk LLC': { primary: '#15d7d7', secondary: '#f8fdfd', accent: '#001725' },
  // Source: brandfetch.com/peraton.com brand page, palette stated in its FAQ
  // (no color names listed).
  'Peraton Corporation': { primary: '#325fac', secondary: '#fefefe', accent: '#0c3d5d' },
  // Source: brandfetch.com/perceptyx.com brand page, named swatches
  // Razzmatazz / White / Black Pearl. Tension recorded: the page's FAQ prose
  // describes a turquoise speech-bubble emblem on a navy-and-white
  // foundation with turquoise/aqua accents, but the named swatches lead with
  // vivid pink #ed2174 and contain no turquoise; navy (Black Pearl) and
  // white are present, so this is not a wholly-disjoint contradiction of the
  // tranche 4 Cyera type; seeded on the named swatch data (tranche 7
  // Moveworks precedent).
  'Perceptyx': { primary: '#ed2174', secondary: '#ffffff', accent: '#040725' },
  // Source: brandfetch.com/perplexity.ai brand page, palette stated in its
  // FAQ (no color names listed).
  'Perplexity AI': { primary: '#20808d', secondary: '#091717', accent: '#fbfaf4' },
  // Source: brandfetch.com/withpersona.com brand page, named swatches
  // Cornflower Blue / Periwinkle / Stratos (Aquamarine #68f0fd and Onahau
  // #cdfaff also listed).
  'Persona Identities, LLC': { primary: '#7379fd', secondary: '#c8cbfe', accent: '#010334' },
  // Source: brandfetch.com/pexip.com brand page, named swatches Blue Zodiac /
  // White / Blue Zodiac; primary and accent are near-identical navies
  // exactly as listed.
  'Pexip Inc.': { primary: '#0a2136', secondary: '#ffffff', accent: '#0b2036' },
  // Source: brandfetch.com/phenom.com brand page (claimed brand), named
  // swatches Royal Blue / Persian Blue / Black (White also listed). Accent
  // #000000 is a single fallback-trio member; swatches named, unique,
  // identity-consistent (Ex Libris precedent).
  'Phenom People, Inc. (Phenom)': { primary: '#4543d9', secondary: '#1f2aac', accent: '#000000' },
  // Source: brandfetch.com/pinecone.io brand page, palette stated in its FAQ
  // (no color names listed; #1f1f33 also listed).
  'Pinecone Systems, Inc.': { primary: '#1c17ff', secondary: '#f1f5f8', accent: '#ffffff' },
  // Source: brandfetch.com/pitneybowes.com brand page, named swatches Red
  // Violet / White / Chambray.
  'Pitney Bowes': { primary: '#cf0989', secondary: '#ffffff', accent: '#314183' },
  // Source: brandfetch.com/platformoneinc.com brand page, named swatches
  // Amethyst / Biloba Flower / Black Russian; About explicitly names
  // PlatformOne Group Inc. and its ComplianceONE software, the registry
  // offering.
  'PlatformOne Group Inc': { primary: '#8a51ce', secondary: '#b6aae8', accent: '#000313' },
  // Source: brandfetch.com/pointblue.org brand page, named swatches
  // Shakespeare / Cornflower / Endeavour.
  'Point Blue Conservation Science': { primary: '#4392ce', secondary: '#8ebee2', accent: '#065ba7' },
  // Source: brandfetch.com/portal26.ai brand page, named swatches Red / White
  // / Charade; About describes the AI security and governance platform that
  // is the registry offering.
  'Portal26, Inc.': { primary: '#ff0000', secondary: '#ffffff', accent: '#2c303c' },
  // Source: brandfetch.com/powertrain.com brand page, named swatches Polo
  // Blue / Cold Purple / Bay of Many; About (training, LMS, founded 1994)
  // matches the registry vendor and its Government Learning Enclave
  // offering.
  'PowerTrain Inc.': { primary: '#93a5cf', secondary: '#a2b6df', accent: '#274c80' },
  // Source: brandfetch.com/praxonlabs.com brand page, named swatches
  // Buttercup / Vesuvius / Catskill White; fallback lettermark icon only.
  'Praxon Labs Inc.': { primary: '#f59e0b', secondary: '#b45309', accent: '#e6edf3' },
  // Source: brandfetch.com/precisely.com brand page, named swatches Electric
  // Violet / White / Windsor.
  'Precisely Software': { primary: '#8017e1', secondary: '#ffffff', accent: '#4f0b8e' },
  // Source: brandfetch.com/privoro.com brand page, named swatches Jumbo /
  // Sail / Blue Lagoon; About names the Fulcrum Platform (registry offering
  // 'Privoro Fulcrum Cloud').
  'Privoro LLC': { primary: '#8a8a8b', secondary: '#a3dffa', accent: '#00778b' },
  // Source: brandfetch.com/procore.com brand page, palette stated in its FAQ
  // (no color names listed; #f5f1ed also listed).
  'Procore Technologies, Inc': { primary: '#ff5201', secondary: '#27455c', accent: '#1a202c' },
  // Source: brandfetch.com/pecinc.com brand page, palette stated in its FAQ
  // (no color names listed); page describes PEC's virtual training and
  // collaborative learning business at the vendor's own domain (registry
  // offering 'Collaborative Learning Environment').
  'Progressive Expert Consulting': { primary: '#00a2ff', secondary: '#8bdfff', accent: '#121936' },
  // Source: brandfetch.com/projectteam.com brand page, palette stated in its
  // FAQ (no color names listed); page describes the construction management
  // platform that is the registry offering.
  'ProjectTeam, Inc.': { primary: '#3b5872', secondary: '#5bb1c6', accent: '#333333' },
  // Source: brandfetch.com/prymeinfil.com brand page, named swatches Yellow
  // Metal / White / Black.
  'Pryme Infil, Inc.': { primary: '#797e42', secondary: '#ffffff', accent: '#030303' },
  // Source: brandfetch.com/psiexams.com brand page, named swatches Parchment
  // / White / Mirage.
  'PSI Services LLC': { primary: '#f2e9d8', secondary: '#ffffff', accent: '#1a212b' },
  // Source: brandfetch.com/ptfs.com brand page, palette stated in its FAQ (no
  // color names listed); About names PTFS (Progressive Technology Federal
  // Systems), Knowvation, and the LibLime division's Bibliovation (registry
  // offering 'Bibliovation/Knowvation'). Accent #000000 is a single
  // fallback-trio member; values unique and identity-consistent (Ex Libris
  // precedent).
  'PTFS/Liblime': { primary: '#26a69a', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/phf.org brand page, named swatches Lynch /
  // Cherokee / Biscay; About names the TRAIN Learning Network, the registry
  // offering.
  'Public Health Foundation': { primary: '#677a9e', secondary: '#fdd79a', accent: '#192f59' },
  // Source: brandfetch.com/qgenda.com brand page, named swatches Eastern Blue
  // / Malibu / Midnight Blue.
  'Qgenda, LLC': { primary: '#1f7bb6', secondary: '#8ed1fc', accent: '#002e61' },
  // Source: brandfetch.com/quadient.com brand page, palette stated in its FAQ
  // (no color names listed).
  'Quadient inc.': { primary: '#ff4200', secondary: '#ffffff', accent: '#252f3f' },
  // Source: brandfetch.com/qualtrics.com brand page, palette stated in its
  // FAQ (no color names listed); five values listed (#232827 and #ffffff
  // also), first three in listed order seeded. Tension recorded: the FAQ
  // prose calls Qualtrics' signature blue the primary canvas with a purple
  // CTA accent, while the listed order leads with mint #20ffc1; blue
  // (#0668dd) and purple (#601ae5) are both present in the seeded three.
  'Qualtrics, LLC': { primary: '#20ffc1', secondary: '#601ae5', accent: '#0668dd' },
  // Source: brandfetch.com/questionmark.com brand page, named swatches
  // Cinnabar / Hit Pink / Cyprus; About states the platform is FedRAMP
  // authorized.
  'QuestionMark': { primary: '#eb3c3f', secondary: '#fdba8c', accent: '#00313d' },
  // Source: brandfetch.com/questionpro.com brand page, named swatches Orange
  // Peel / Curious Blue / White (Jacksons Purple #1b3380 also listed).
  'QuestionPro, Inc.': { primary: '#ff9f00', secondary: '#1b87e6', accent: '#ffffff' },
  // Source: brandfetch.com/quzara.com brand page, palette stated in its FAQ
  // (no color names listed); About names Quzara Cybertorch, the registry
  // offering.
  'Quzara, LLC.': { primary: '#fab734', secondary: '#63bdf2', accent: '#1a4268' },
  // Tranche 9 (Nov 15, 2026): the next 60 default-palette vendors in registry
  // order after Quzara, LLC, from R&K Solutions, Inc through SRR
  // International,Inc. Specset sits inside this registry range but was
  // already decided on the record in tranche 2 (its listing states exactly
  // two colors), so it was skipped and not counted again; the counted 60 run
  // R&K Solutions, Inc through Somnoware Healthcare Systems plus Spectro
  // Cloud, Spider Strategies, Sprinklr, Inc. and SRR International,Inc. 52
  // moved to researched. StackArmor (capital S) is the 61st counted vendor,
  // a distinct registry string from the tranche 1 seed 'stackArmor'; it was
  // not seeded here and is recorded as tranche 10's first entry, which can
  // carry the same verified palette to the duplicate string. Stayed default
  // on the record: Red Rock Group Holdings (company identified, flagship
  // platform Ekko at getekko.io, registry offering GetEKKO, but
  // brandfetch.com/getekko.io is 404 and no other citable hex source found);
  // RegDOX Solutions (domain regdox.com confirmed as its own site, but
  // brandfetch.com/regdox.com is 404 and no guidelines or listing stating
  // hex values found); Relocation Management Worldwide (RMW) (domain
  // relomw.com confirmed, registry offering VEN, but brandfetch.com/
  // relomw.com is 404 and no other citable source found); RSA Security LLC
  // (brandfetch.com/rsa.com rejected as internally contradictory: its About
  // describes RSA Insurance Group, the London insurer, while its logo prose
  // describes the security company, so its FAQ palette is unattributable
  // between the two identities; the vendor's own published identity
  // standards give exactly two colors, Pantone 485 red and black, and no
  // third value is citable, the accent never invented); Secunetics, Inc.
  // (domain secunetics.com confirmed, registry offering Gobo Framework, but
  // brandfetch.com/secunetics.com is 404 and no citable hex source found);
  // Security Control LLC (an ISI Company) (company identified as ISI
  // Enterprises' Security Control platform; the only Brandfetch page,
  // brandfetch.com/isidefense.com, presents parent ISI's own brand and
  // lists exactly two colors, #d6f7a3 and #344f5d: the parent's palette is
  // not seedable as the vendor's, and two colors would not suffice in any
  // case); SMX and SMX (Formerly Smartronix) (same company, same page:
  // brandfetch.com/smxtech.com carries the exact Brandfetch fallback trio
  // #d6964a/#6bbaef/#000000 with a fallback lettermark icon, non-citable on
  // sight, tranche 3 precedent; its prose colors also contradict the trio).
  // Judgment calls recorded in the per-entry comments: Rackspace Government
  // Solutions and SAS Institute seeded on their pages' stated palettes
  // despite partial prose tension (tranche 7 Moveworks precedent); Rave
  // Mobile Safety seeded as the vendor's own palette expressly stated at
  // its own domain; Software AG Government Solutions seeded from the parent
  // Software AG brand the subsidiary carries (parent-brand precedent);
  // Seven Bridges seeded from a page presenting Seven Bridges' own brand,
  // not its Velsera successor. Eight seeds carry #000000 as a single
  // fallback-trio member with named, unique, identity-consistent swatches
  // (RegScale accent, RegScale, Inc. accent, RingMD accent, Ripcord accent,
  // Secureframe accent, Seven Bridges accent, Repario accent, Sprinklr
  // secondary): flagged per entry, tranche 5 Ex Libris precedent; the
  // fallback trio itself appears in none.
  // Source: brandfetch.com/rksolutions.com brand page, palette stated in
  // its FAQ (no color names listed); page names GoRPM, the registry
  // offering.
  'R&K Solutions, Inc': { primary: '#ba2a24', secondary: '#ffffff', accent: '#15202d' },
  // Source: brandfetch.com/rackspace.com brand page (Rackspace Technology),
  // palette stated in its FAQ (no color names listed). Partial prose
  // tension recorded: the branding prose mentions deep navy panels and a
  // black logotype, neither in the hex list; the bright red leads both.
  // Seeded on the stated palette (tranche 7 Moveworks precedent); the
  // government division carries the parent brand.
  'Rackspace Government Solutions': { primary: '#eb0000', secondary: '#e6a65a', accent: '#bd6d21' },
  // Source: brandfetch.com/rapid7.com brand page, named swatches Flamingo /
  // Outer Space / White; registry offering is InsightGovCloud.
  'Rapid7': { primary: '#e85e26', secondary: '#242b2e', accent: '#ffffff' },
  // Source: brandfetch.com/ravemobilesafety.com brand page, named swatches
  // Pomegranate / White / Cello. Judgment: the page's logo prose notes Rave
  // appears within parent Motorola Solutions' identity, but the colors
  // section and palette FAQ expressly state Rave Mobile Safety's own
  // palette and the About describes Rave's own products (registry offering
  // Rave Safety Platform): the vendor's own brand page at its own domain.
  'Rave Mobile Safety': { primary: '#ee3a24', secondary: '#ffffff', accent: '#1d2d5c' },
  // Source: brandfetch.com/recaccess.com brand page, palette stated in its
  // FAQ (no color names listed); recreation access management matches the
  // registry offering.
  'RecAccess': { primary: '#e85d00', secondary: '#f9d196', accent: '#010a1b' },
  // Source: brandfetch.com/regscale.com brand page, named swatches Curious
  // Blue / White / Black. Accent #000000 is a single fallback-trio member;
  // swatches named, unique, identity-consistent (Ex Libris precedent).
  'RegScale': { primary: '#2aa4ca', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/regscale.com brand page, named swatches Curious
  // Blue / White / Black; same company as RegScale, duplicate registry
  // entry, same seed. Accent #000000 single fallback-trio member (Ex Libris
  // precedent).
  'RegScale, Inc.': { primary: '#2aa4ca', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/relativity.com brand page, named swatches
  // Christine / Cod Gray / White; About names RelativityOne (registry
  // offering RelativityOne Government).
  'Relativity ODA LLC': { primary: '#ef5f11', secondary: '#111111', accent: '#ffffff' },
  // Source: brandfetch.com/reliaquest.com brand page, named swatches
  // Persian Green / Alabaster / Viridian; header names GreyMatter, the
  // registry offering (GreyMatter for Government).
  'ReliaQuest': { primary: '#00afab', secondary: '#fcfcfc', accent: '#41947f' },
  // Source: brandfetch.com/remedio.io brand page, named swatches Royal Blue
  // / Stratos / Picton Blue.
  'Remedio Technologies Inc': { primary: '#593de8', secondary: '#000333', accent: '#4ca3f4' },
  // Source: brandfetch.com/repariodata.com brand page, named swatches
  // Milano Red / White / Black; the company's own domain is repariodata.com
  // (Repario Data, LLC). Accent #000000 is a single fallback-trio member;
  // swatches named, unique, identity-consistent (Ex Libris precedent).
  'Repario': { primary: '#ab0f03', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/replit.com brand page, palette stated in its FAQ
  // (no color names listed); prose consistent (orange mark, charcoal,
  // off-white).
  'Replit, Inc.': { primary: '#ff3c00', secondary: '#1e1e1f', accent: '#fbf6f1' },
  // Source: brandfetch.com/rescale.com brand page, named swatches Boston
  // Blue / Firefly / Spray.
  'Rescale': { primary: '#3399bb', secondary: '#051016', accent: '#7af0f5' },
  // Source: brandfetch.com/irbnet.org brand page (IRBNet), palette stated
  // in its FAQ (no color names listed); the page's own footer reads
  // Research Dataware, LLC, the vendor itself; registry offering is IRBNet
  // on GovCloud (product-brand precedent).
  'Research Dataware LLC': { primary: '#00b4ed', secondary: '#9cbed9', accent: '#19315f' },
  // Source: brandfetch.com/ring.md brand page, named swatches Sunset Orange
  // / Froly / Black; header describes turnkey telemedicine for governments.
  // Accent #000000 is a single fallback-trio member; fallback lettermark
  // icon only, swatches named, unique, identity-consistent (Ex Libris
  // precedent).
  'RingMD USA Inc.': { primary: '#fd4b38', secondary: '#f58e83', accent: '#000000' },
  // Source: brandfetch.com/ripcord.com brand page, named swatches Hippie
  // Blue / Sandy brown / Black; registry offering is Canopy. Accent
  // #000000 is a single fallback-trio member; swatches named, unique,
  // identity-consistent (Ex Libris precedent).
  'Ripcord': { primary: '#50a0aa', secondary: '#f49c6c', accent: '#000000' },
  // Source: brandfetch.com/riverbed.com brand page, palette stated in its
  // FAQ (no color names listed); prose consistent.
  'Riverbed Technology': { primary: '#7648c6', secondary: '#e771e4', accent: '#272855' },
  // Source: brandfetch.com/rohirrim.ai brand page, named swatches Cerulean
  // / White / Big Stone; header matches the Unified Acquisition Platform
  // registry offering.
  'Rohirrim, Inc.': { primary: '#00acd8', secondary: '#ffffff', accent: '#111d2a' },
  // Source: brandfetch.com/rosalind.bio brand page, palette stated in its
  // FAQ (no color names listed); the ROSALIND genomics platform.
  'Rosalind, Inc.': { primary: '#00a4bd', secondary: '#9fc5e8', accent: '#19406b' },
  // Source: brandfetch.com/rqipartners.com brand page, named swatches
  // Cardinal / Mine Shaft / Roman; the AHA/Laerdal joint venture; registry
  // offering is RQI1Stop.
  'RQI Partners LLC': { primary: '#ce232b', secondary: '#212121', accent: '#da5b5f' },
  // Source: brandfetch.com/rubrik.com brand page, palette stated in its FAQ
  // listing four values; first three seeded (White #ffffff also listed).
  'Rubrik': { primary: '#0ac9bb', secondary: '#005781', accent: '#022125' },
  // Source: brandfetch.com/sandboxaq.com brand page, named swatches Anzac /
  // White / Asphalt.
  'SandboxAQ': { primary: '#e2b147', secondary: '#ffffff', accent: '#060203' },
  // Source: brandfetch.com/sas.com brand page, palette stated in its FAQ
  // (no color names listed). Partial prose tension recorded: the prose
  // describes a blue wordmark and a deep navy and bright blue palette while
  // the listed palette leads with orange; navy and white appear in both.
  // Seeded on the page's stated palette (tranche 7 Moveworks precedent).
  'SAS Institute, Inc.': { primary: '#ff8224', secondary: '#ffffff', accent: '#02183b' },
  // Source: brandfetch.com/saviynt.com brand page, named swatches Electric
  // Violet / Tango / Ebony.
  'Saviynt': { primary: '#6d28fe', secondary: '#f5822a', accent: '#0f172a' },
  // Source: brandfetch.com/saviynt.com brand page, named swatches Electric
  // Violet / Tango / Ebony; same company as Saviynt, duplicate registry
  // entry, same seed.
  'Saviynt, Inc.': { primary: '#6d28fe', secondary: '#f5822a', accent: '#0f172a' },
  // Source: brandfetch.com/sciencelogic.com brand page, named swatches
  // Apple / Downriver / Bittersweet.
  'ScienceLogic, Inc.': { primary: '#52b748', secondary: '#0a214d', accent: '#fb6962' },
  // Source: brandfetch.com/secondfront.com brand page, named swatches Blue
  // Ribbon / White / Bunker; registry offering is 2F Game Warden.
  'Second Front Systems': { primary: '#0047ff', secondary: '#ffffff', accent: '#05070a' },
  // Source: brandfetch.com/secureframe.com brand page, named swatches
  // Firefly / Anakiwa / Black. Accent #000000 is a single fallback-trio
  // member; swatches named, unique, identity-consistent (Ex Libris
  // precedent).
  'Secureframe': { primary: '#091922', secondary: '#b1e3ff', accent: '#000000' },
  // Source: brandfetch.com/securin.io brand page, named swatches Heliotrope
  // / White / Ebony; header names the Preemptive Exposure Management
  // registry offering.
  'Securin, Inc.': { primary: '#9c66ff', secondary: '#ffffff', accent: '#07060d' },
  // Source: brandfetch.com/securityscorecard.com brand page, named swatches
  // Royal Blue / Cod Gray / Fog (White #ffffff also listed).
  'SecurityScorecard, LLC': { primary: '#673ef3', secondary: '#060606', accent: '#d8cdff' },
  // Source: brandfetch.com/sentilink.com brand page, named swatches Crimson
  // / Dull Lavender / Cloud Burst.
  'SentiLink Corp': { primary: '#ed1c24', secondary: '#8d8de5', accent: '#232d47' },
  // Source: brandfetch.com/sevenbridges.com brand page, named swatches
  // Tarawera / Portage / Black; the page presents Seven Bridges' own brand
  // and About, not its Velsera successor. Accent #000000 is a single
  // fallback-trio member; swatches named, unique, identity-consistent (Ex
  // Libris precedent).
  'Seven Bridges Genomics, Inc': { primary: '#083050', secondary: '#9896f0', accent: '#000000' },
  // Source: brandfetch.com/signatureperformance.com brand page, palette
  // stated in its FAQ (no color names listed); About names ClaimsXM, the
  // registry offering.
  'Signature Performance, Inc.': { primary: '#e00838', secondary: '#685bc7', accent: '#830029' },
  // Source: brandfetch.com/signifisolutions.com brand page, named swatches
  // Amaranth / Mine Shaft / White; About names SignifiVISION, the registry
  // offering; fallback lettermark icon only.
  'Signifi Solutions Inc.': { primary: '#e22f4a', secondary: '#1f1f1f', accent: '#ffffff' },
  // Source: brandfetch.com/silkline.ai brand page, named swatches Pastel
  // Green / Merino / Mirage.
  'Silkline, Inc.': { primary: '#82eb71', secondary: '#f7f2e8', accent: '#16152b' },
  // Source: brandfetch.com/simu.health brand page, named swatches Ebony
  // Clay / White / Shuttle Gray; About describes the healthcare simulation
  // management platform, matching the vendor (Simuhealth Technologies).
  'Simuhealth Technologies Inc.': { primary: '#202532', secondary: '#ffffff', accent: '#5d6c7b' },
  // Source: brandfetch.com/sirsidynix.com brand page (SirsiDynix), named
  // swatches Congress Blue / Regent St Blue / Elephant; About names
  // EOS.Web, the registry offering.
  'Sirsi Corporation (SirsiDynix)': { primary: '#004b8d', secondary: '#aad2e4', accent: '#123d5d' },
  // Source: brandfetch.com/siteimprove.com brand page, named swatches Denim
  // / Bright Turquoise / Black Squeeze (White #ffffff and Blue Zodiac
  // #141155 also listed).
  'Siteimprove Inc': { primary: '#0e4cd3', secondary: '#23e8e8', accent: '#eaf3f7' },
  // Source: brandfetch.com/sixtyfour.ai brand page, palette stated in its
  // FAQ (no color names listed); page describes the identity intelligence
  // company behind the Sixtyfour Identity Intelligence Platform offering.
  'Sixtyfourai': { primary: '#8c8c8c', secondary: '#f5f5f5', accent: '#0a0a0a' },
  // Source: brandfetch.com/skyhighsecurity.com brand page, named swatches
  // Royal Blue / Portage / Violet; About names the SSE platform registry
  // offering.
  'Skyhigh Security': { primary: '#3664f4', secondary: '#9896f0', accent: '#0a103d' },
  // Source: brandfetch.com/skywarditsolutions.com brand page, palette
  // stated in its FAQ (no color names listed); page describes the vendor
  // itself.
  'Skyward IT Solutions': { primary: '#f7e124', secondary: '#ffffff', accent: '#111111' },
  // Source: brandfetch.com/smartsheet.com brand page, named swatches Denim
  // / Pine Green / Midnight (White #ffffff also listed).
  'Smartsheet': { primary: '#1957de', secondary: '#00796f', accent: '#001033' },
  // Source: brandfetch.com/snyk.io brand page, named swatches Denim /
  // Whisper / Blue Charcoal.
  'Snyk': { primary: '#145deb', secondary: '#f6f4fa', accent: '#01011e' },
  // Source: brandfetch.com/socure.com brand page (claimed brand), named
  // swatches Blaze Orange / White / Cod Gray.
  'Socure, Inc.': { primary: '#ff6900', secondary: '#ffffff', accent: '#0d0d0d' },
  // Source: brandfetch.com/softwareag.com brand page (parent Software AG),
  // palette stated in its FAQ listing four values; first three seeded
  // (#011f3d also listed). Judgment: the government subsidiary's own domain
  // has no Brandfetch page; the subsidiary carries the parent Software AG
  // brand and the registry offering is ARIS Government Cloud, Software AG's
  // own product (parent-brand precedent: Ipsos America, Optum Serve, NICE
  // CXone).
  'Software AG Government Solutions': { primary: '#8e3cf7', secondary: '#058192', accent: '#ffffff' },
  // Source: brandfetch.com/sofwarellc.com brand page, named swatches Apple
  // / Malibu / Salem; About describes FORGE, the registry offering,
  // developed by Naval Special Warfare operators.
  'SOFware LLC': { primary: '#6fb344', secondary: '#8acaf9', accent: '#16a34a' },
  // Source: brandfetch.com/solventum.com brand page, named swatches
  // Malachite / Equator / Deep Teal.
  'Solventum': { primary: '#05dd4d', secondary: '#e0c266', accent: '#01332b' },
  // Source: brandfetch.com/somnoware.com brand page, named swatches
  // Downriver / White / Downriver (two navy values exactly as listed).
  'Somnoware Healthcare Systems': { primary: '#091e42', secondary: '#ffffff', accent: '#102661' },
  // Source: brandfetch.com/spectrocloud.com brand page, named swatches Elm
  // / Dawn Pink / Cape Cod; About names Palette, the registry offering
  // (Palette VerteX).
  'Spectro Cloud': { primary: '#1f7a78', secondary: '#f7f1ed', accent: '#3c4949' },
  // Source: brandfetch.com/spiderstrategies.com brand page, palette stated
  // in its FAQ (no color names listed); page names Spider Impact, the
  // registry offering (Spider Impact for Government).
  'Spider Strategies': { primary: '#04b1e4', secondary: '#eef5ff', accent: '#003583' },
  // Source: brandfetch.com/sprinklr.com brand page, palette stated in its
  // FAQ (no color names listed). Secondary #000000 is a single fallback-trio
  // member in an otherwise unique, identity-consistent palette (Ex Libris
  // precedent).
  'Sprinklr, Inc.': { primary: '#107eff', secondary: '#000000', accent: '#ffffff' },
  // Source: brandfetch.com/srrintl.com brand page, named swatches Endeavour
  // / Havelock Blue / Cod Gray; About names CloudLCMS, the registry
  // offering, and the vendor's 8(a)/EDWOSB identity; fallback lettermark
  // icon only.
  'SRR International,Inc.': { primary: '#0055a4', secondary: '#5aa1e3', accent: '#101010' },
  // Tranche 10 (Nov 15, 2026): the next 60 default-palette vendors in
  // registry order after SRR International,Inc., from StackArmor through
  // Vbrick Systems, Inc. 49 moved to researched. Stayed default on the
  // record: Standard Technology Inc. (company identified, STI of
  // Bethesda MD, its COMPASS product matches the registry offering
  // Contract Management Planning and Surveillance System, own domain
  // stic2.com, but brandfetch.com/stic2.com is 404 and no other citable
  // hex source found); Syneren Technologies Corporation (its only
  // listing, brandfetch.com/syneren.com, states exactly two colors,
  // #ffffff and #1b1b1b; no third value citable, the accent never
  // invented); Tactical Takedown LLC (company could not be identified to
  // any citable source; searches for its TNT Business Resilience
  // Platform surfaced only unrelated TNT entities); Tansi LLC
  // (identified through its FedRAMP Marketplace entry, website
  // tansi.app, but brandfetch.com/tansi.app is 404 and no other citable
  // hex source found); TeleTech (TTEC) Services Corporation
  // (brandfetch.com/ttec.com exists but states no palette at all, and no
  // citable guidelines source found); TERIDA (brandfetch.com/terida.com
  // is 404 and no citable hex source found); TGuardAI Inc. (company
  // identified, TrustGuard AI at trustguardai.com, but no Brandfetch
  // page at that domain or at tguardai.com and no other citable hex
  // source found); ThreatConnect (brandfetch.com/threatconnect.com
  // rejected: the page now presents acquirer Dataminr, its palette
  // expressly stated as Dataminr's, while its About still describes
  // ThreatConnect; Dataminr acquired ThreatConnect in 2025, tranche 8
  // OnSolve precedent; no citable source for ThreatConnect's own palette
  // found); TransUnion LLC (brandfetch.com/transunion.com is 404; no
  // official brand hex is published and only one logo color, turquoise
  // #00a6ca, is citable anywhere, fewer than the three slots required);
  // Trustwave Government Solutions (brandfetch.com/trustwave.com
  // rejected: the page now presents LevelBlue, its palette expressly
  // stated as LevelBlue's, while its About still describes Trustwave;
  // LevelBlue acquired Trustwave in 2025, acquirer precedent); Valley IT
  // Solutions, LLC (brandfetch.com/valleyit.com rejected as internally
  // contradictory: its header describes the registry vendor, the
  // Southern Pines NC defense firm that is platform partner for the
  // KERNOS offering, while its About describes an unrelated Valley IT
  // Solutions, an IT procurement reseller in Fargo ND, so the palette is
  // unattributable between the two identities). Judgment calls recorded
  // in the per-entry comments: StackArmor carries the tranche 1
  // 'stackArmor' palette to the duplicate registry string, re-verified
  // at the same page; SuperGov, Inc seeded from the SuperFile product
  // brand its registry offering carries; Transmittr, Inc. seeded from
  // the Casco product brand (the company trades as Transmittr, Inc.
  // d/b/a Casco); United Solutions seeded from the US AI brand the
  // company operates under (US AI is its registered trademark); Tango
  // resolved to Tango Analytics, the tangocard.com rewards company
  // rejected as the wrong company; Tyler Technologies Data & Insights
  // seeded from the parent Tyler Technologies brand the division
  // carries; USDA DISC seeded with the USDA department palette, the same
  // seed as United States Department of Agriculture (agency precedent);
  // Valimail seeded from its own brand page although the wordmark now
  // carries a DigiCert tagline; Trenchant Analytics seeded from the
  // palette stated at its own domain, tacgov.com, whose About text is
  // stale legacy-services copy for the same named LLC. Seven seeds carry
  // #000000 as a single fallback-trio member with named, unique,
  // identity-consistent swatches (StackArmor secondary, Stoke Space
  // Technologies secondary, Synack accent, ThinkTrends accent, Thread AI
  // secondary, TimeLooper Xplore accent, TRAPWIRE accent): flagged per
  // entry, tranche 5 Ex Libris precedent; the fallback trio itself
  // appears in none. Partial prose tension recorded per entry for Stoke
  // Space Technologies, Sustainment Technologies and Vanta (tranche 7
  // Moveworks precedent). Veracode is the 61st vendor in registry order;
  // it was not researched in this tranche and stands as tranche 11's
  // first entry.
  // Source: brandfetch.com/stackarmor.com brand page, named swatches Bay
  // of Many / Turquoise Blue / Black; re-fetched and confirmed exactly
  // as recorded for the tranche 1 seed 'stackArmor'. Same company,
  // duplicate registry string, same seed. Secondary #000000 is a single
  // fallback-trio member; swatches named, unique, identity-consistent
  // (Ex Libris precedent).
  'StackArmor': { primary: '#244d80', secondary: '#000000', accent: '#4aeadc' },
  // Source: brandfetch.com/steelpatriotpartners.com brand page, named
  // swatches Persian Green / Ronchi / Blue Zodiac; header names FedRAMP
  // and CMMC compliance work, registry offering is Federal ZenGRC.
  'Steel Patriot Partners': { primary: '#01b0a3', secondary: '#e8b84b', accent: '#0d2340' },
  // Source: brandfetch.com/stell-engineering.com brand page, named
  // swatches Caribbean Green / Alabaster / Cod Gray; About describes the
  // specifications and requirements platform, registry offering is the
  // Stell Requirements Management System (SRMS).
  'Stell Engineering': { primary: '#00d07b', secondary: '#fafafa', accent: '#0a0a0a' },
  // Source: brandfetch.com/stokespace.com brand page, named swatches
  // Polo Blue / Black / Concrete. Secondary #000000 is a single
  // fallback-trio member; swatches named, unique, identity-consistent
  // (Ex Libris precedent). Partial prose tension recorded: the branding
  // prose cites vivid orange accents, none of which appear in the
  // swatches; seeded on the swatch data (Moveworks precedent).
  'Stoke Space Technologies, Inc.': { primary: '#93b1cc', secondary: '#000000', accent: '#f2f2f2' },
  // Source: brandfetch.com/sumologic.com brand page, palette stated in
  // its FAQ (no color names listed).
  'Sumo Logic': { primary: '#000099', secondary: '#bae0f0', accent: '#1b5a7d' },
  // Source: brandfetch.com/sunstonesecure.com brand page, named swatches
  // Dodger Blue / Athens Gray / Downriver; header names the Artemis
  // Platform, the registry offering; fallback lettermark icon only.
  'SunStone Secure, LLC': { primary: '#33ccff', secondary: '#f2f4f6', accent: '#07234a' },
  // Source: brandfetch.com/superfile.com brand page (SuperFile), named
  // swatches Electric Lime / White / Abbey. Judgment: the registry
  // offering is SuperFile and the page's About matches the registry
  // description in substance (a permission and compliance layer for file
  // transfers); the vendor operates under the SuperFile product brand
  // (product-brand precedent); fallback lettermark icon only.
  'SuperGov, Inc': { primary: '#d1ff00', secondary: '#ffffff', accent: '#4a4a4f' },
  // Source: brandfetch.com/sustainment.com brand page, named swatches
  // Monza / Selago / Shark; About describes the manufacturing market
  // network, the registry offering (Sustainment Digital Manufacturing
  // Hub). Partial prose tension recorded: the logo prose mentions vivid
  // electric blue highlights, not among the swatches; seeded on the
  // swatch data (Moveworks precedent).
  'Sustainment Technologies Inc.': { primary: '#d00441', secondary: '#f7fbfe', accent: '#181b20' },
  // Source: brandfetch.com/synack.com brand page, named swatches Blue
  // Ribbon / White / Black. Accent #000000 is a single fallback-trio
  // member; swatches named, unique, identity-consistent (Ex Libris
  // precedent).
  'Synack': { primary: '#006bff', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/synergetics.com brand page, named swatches
  // Orient / White / Mine Shaft; About names OpenFLIS, the registry
  // offering, and the Colorado federal IT company itself.
  'Synergetics Incorporated': { primary: '#005a87', secondary: '#ffffff', accent: '#313131' },
  // Source: brandfetch.com/tmetrics.com brand page, palette stated in
  // its FAQ (no color names listed); About describes contact center
  // solutions, registry offering is TCCC.
  'T-Metrics, Inc.': { primary: '#ff2d37', secondary: '#ffb1be', accent: '#7c0025' },
  // Source: brandfetch.com/tacticaledge.us brand page, named swatches
  // Pizazz / Cornflower Blue / Biscay; About names Total Visibility
  // Anywhere (TVA), the registry offering.
  'Tactical Edge': { primary: '#ff9800', secondary: '#569ff7', accent: '#1b305a' },
  // Source: brandfetch.com/talatek.com brand page, palette stated in its
  // FAQ (no color names listed); About names TiGRIS, the registry
  // offering. The page notes TalaTek sits in the CISO Global family; the
  // page and palette are TalaTek's own (Huddle precedent).
  'TalaTek, LLC': { primary: '#507497', secondary: '#ffffff', accent: '#0a0101' },
  // Source: brandfetch.com/talkdesk.com brand page (claimed brand),
  // named swatches Purple / Tolopea / White.
  'Talkdesk': { primary: '#5405bd', secondary: '#1e0044', accent: '#ffffff' },
  // Source: brandfetch.com/tangoanalytics.com brand page, named swatches
  // Midnight / Malibu / Monza. Judgment: the registry room description
  // names Tango Reserve, the workplace and IWMS product of Tango
  // Analytics; the palette at brandfetch.com/tangocard.com belongs to
  // the unrelated gift-card rewards company and was rejected as the
  // wrong company.
  'Tango': { primary: '#001e36', secondary: '#8ed1fc', accent: '#d80032' },
  // Source: brandfetch.com/tanium.com brand page, named swatches
  // Alizarin Crimson / White / Cinder.
  'Tanium': { primary: '#ec3430', secondary: '#ffffff', accent: '#09080d' },
  // Source: brandfetch.com/teamviewer.com brand page, palette stated in
  // its FAQ (no color names listed).
  'TeamViewer': { primary: '#3056ef', secondary: '#050a52', accent: '#ffffff' },
  // Source: brandfetch.com/technomile.com brand page, palette stated in
  // its FAQ (no color names listed).
  'TechnoMile': { primary: '#4646de', secondary: '#9f8dff', accent: '#1a1a2e' },
  // Source: brandfetch.com/techtrend.us brand page, named swatches
  // Meteor / White / Astronaut; header names FedRAMP DevSecOps, the
  // registry offering area.
  'TechTrend, Inc.': { primary: '#d97310', secondary: '#ffffff', accent: '#2a276f' },
  // Source: brandfetch.com/tecsys.com brand page, named swatches Red /
  // White / Big Stone.
  'Tecsys, Inc.': { primary: '#ff0000', secondary: '#ffffff', accent: '#152934' },
  // Source: brandfetch.com/telos.com brand page, named swatches Astral /
  // Sandy brown / Midnight Blue; About names Xacta, the registry
  // offering.
  'Telos Corporation': { primary: '#307cb0', secondary: '#ef9f53', accent: '#002d5d' },
  // Source: brandfetch.com/coleridgeinitiative.org brand page, named
  // swatches Spring Green / White / Big Stone; About names the ADRF,
  // the registry offering.
  'The Coleridge Initiative, Inc.': { primary: '#00e761', secondary: '#ffffff', accent: '#161d3e' },
  // Source: brandfetch.com/thinktrends.co brand page (the company's own
  // domain is .co), palette stated in its FAQ (no color names listed).
  // Accent #000000 is a single fallback-trio member in an otherwise
  // unique, identity-consistent palette (Ex Libris precedent).
  'ThinkTrends LLC': { primary: '#0063be', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/threadai.com brand page, named swatches
  // Shakespeare / Black / Wild Sand; header names the Lemma
  // orchestration platform, the registry offering. Secondary #000000 is
  // a single fallback-trio member; swatches named, unique,
  // identity-consistent (Ex Libris precedent).
  'Thread AI, Inc.': { primary: '#4790cd', secondary: '#000000', accent: '#f5f5f5' },
  // Source: brandfetch.com/timelooper.com brand page, named swatches
  // Alizarin Crimson / White / Black. Accent #000000 is a single
  // fallback-trio member; swatches named, unique, identity-consistent
  // (Ex Libris precedent).
  'TimeLooper Xplore': { primary: '#d81f27', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/toonimo.com brand page, named swatches
  // Mountain Meadow / Athens Gray / Pickled Bluewood.
  'Toonimo Inc.': { primary: '#24c05f', secondary: '#f3f5f7', accent: '#2c3e50' },
  // Source: brandfetch.com/totara.com brand page, palette stated in its
  // FAQ listing five values; first three seeded (White #ffffff and Teal
  // #36bdb1 also listed).
  'Totara Learning Inc.': { primary: '#0d4b55', secondary: '#007ab8', accent: '#033c65' },
  // Source: brandfetch.com/trackvia.com brand page, palette stated in
  // its FAQ (no color names listed).
  'TrackVia, Inc.': { primary: '#2d76d4', secondary: '#ffffff', accent: '#0a1a37' },
  // Source: brandfetch.com/casco.com brand page, named swatches Cyan /
  // Aqua / Old Lace / Swamp. Judgment: the vendor trades as Transmittr,
  // Inc. d/b/a Casco (its own government page states the legal name) and
  // the registry offering is Casco for Government; seeded from the Casco
  // product brand (product-brand precedent).
  'Transmittr, Inc.': { primary: '#00fff2', secondary: '#fefdf6', accent: '#002626' },
  // Source: brandfetch.com/trapwire.com brand page, named swatches
  // Persian Red / White / Black. Accent #000000 is a single fallback-trio
  // member; swatches named, unique, identity-consistent (Ex Libris
  // precedent).
  'TRAPWIRE': { primary: '#cf2e2e', secondary: '#ffffff', accent: '#000000' },
  // Source: brandfetch.com/tacgov.com brand page (Trenchant Analytics,
  // LLC), palette stated in its FAQ (no color names listed). Judgment:
  // tacgov.com is the domain the company's own press releases cite as
  // its website; the page's About text is stale legacy defense-services
  // copy but names the same LLC, and the palette is stated for
  // that brand at its own domain. Flagged for the record.
  'Trenchant Analytics': { primary: '#22d3ee', secondary: '#6366f1', accent: '#0e0d11' },
  // Source: Trimble's own Modus design system,
  // modus-v1.trimble.com/foundations/color-palette, Primary Palette in
  // listed order: Trimble Blue Dark / Trimble Blue / Trimble Yellow /
  // Trimble Gray; first three seeded (Trimble Gray #252a2e also listed).
  // The vendor's own guidelines outrank listings; the Brandfetch page at
  // trimble.com was rejected because it presents subsidiary
  // Transporeon's palette expressly under Transporeon's name.
  'Trimble Inc.': { primary: '#004f83', secondary: '#0063a3', accent: '#fbad26' },
  // Source: brandfetch.com/trisotech.com brand page, named swatches Deep
  // Cerulean / Gallery / Blue Stone; About names the Digital Enterprise
  // Suite, the registry offering.
  'Trisotech': { primary: '#00889d', secondary: '#f0f0f0', accent: '#005c6a' },
  // Source: brandfetch.com/trmlabs.com brand page, palette stated in its
  // FAQ (no color names listed).
  'TRM Labs, Inc.': { primary: '#fcba04', secondary: '#ffffff', accent: '#071c2d' },
  // Source: brandfetch.com/tpgsi.com brand page, named swatches Dark
  // Blue / Pomegranate / Mine Shaft; About names NiOS, the registry
  // offering.
  'Turning Point Global Solutions, L.L.C': { primary: '#0102ce', secondary: '#f44336', accent: '#333333' },
  // Source: brandfetch.com/tylertech.com brand page, palette stated in
  // its FAQ listing four values; first three seeded (White #ffffff also
  // listed). Judgment: the Data & Insights division (registry offering
  // Tyler Data Platform) carries the parent Tyler Technologies brand
  // (parent-brand precedent). The pre-existing 'Tyler Federal, LLC' seed
  // came from its own source in a different slot order and is unchanged.
  'Tyler Technologies Data & Insights': { primary: '#909b48', secondary: '#1278c0', accent: '#045590' },
  // Source: brandfetch.com/uberether.com brand page, palette stated in
  // its FAQ (no color names listed); identity management in Sterling VA,
  // registry offering is IAM Advantage.
  'UberEther': { primary: '#f57e20', secondary: '#f8f8f8', accent: '#373e46' },
  // Source: brandfetch.com/ultra.security brand page, named swatches
  // Mine Shaft / Shamrock / Deep Blush; About describes the agentic
  // runtime security platform, the registry offering.
  'Ultra Security, Inc.': { primary: '#323232', secondary: '#4ade80', accent: '#ed6c9d' },
  // Source: brandfetch.com/usai.io brand page (US AI), named swatches
  // Razzmatazz / Russet / Vista White. Judgment: United Solutions, LLC
  // operates as US AI (US AI is its registered trademark, USPTO serial
  // 98438184) and the registry offering is US AI; seeded from the brand
  // the company itself trades under.
  'United Solutions': { primary: '#e40c62', secondary: '#7d3d18', accent: '#fdfcfa' },
  // Source: brandfetch.com/unqork.com brand page, palette stated in its
  // FAQ (no color names listed).
  'Unqork, Inc.': { primary: '#33768e', secondary: '#ffffff', accent: '#092750' },
  // Source: USDA's official Design and Brand page, "USDA Colors": Dark
  // Blue #002d72 (PMS 288) and Dark Green #005440 (PMS 343), logo on a
  // white masthead field:
  // https://www.usda.gov/digital-strategy/design-and-brand/plays, the
  // same source as the existing 'United States Department of
  // Agriculture' seed. Judgment: DISC is a USDA office (Digital
  // Infrastructure Services Center, registry offering Connect.gov) with
  // no independent public brand identity; seeded with the department
  // palette (agency precedent).
  'USDA DISC': { primary: '#002d72', secondary: '#ffffff', accent: '#005440' },
  // Source: brandfetch.com/usu.com brand page, named swatches Midnight
  // Blue / Malibu / Abbey; About names IT asset management, the registry
  // offering (USU IT Asset Management); the US subsidiary carries the
  // USU brand.
  'USU Solutions Inc.': { primary: '#002773', secondary: '#5fc2f6', accent: '#4a494e' },
  // Source: brandfetch.com/valid8financial.com brand page, named
  // swatches Jade / White / Aqua Deep.
  'Valid8 Financial': { primary: '#009e79', secondary: '#ffffff', accent: '#00523f' },
  // Source: brandfetch.com/valimail.com brand page, palette stated in
  // its FAQ listing four values; first three seeded (Black Rock #1c0642
  // also listed). Judgment: the wordmark now carries an "a digicert
  // company" tagline, but the page presents Valimail's own brand and
  // palette and its About names Enforce, the registry offering: the
  // vendor's own brand page at its own domain (own-page precedent);
  // fallback lettermark icon only.
  'Valimail': { primary: '#0000ff', secondary: '#29338a', accent: '#d2e8fa' },
  // Source: brandfetch.com/vanta.com brand page (claimed brand), named
  // swatches Vanta Purple / Vanta White / Vanta Dark Purple. Partial
  // prose tension recorded: the logo prose describes a navy and blue
  // wordmark, while the named proprietary swatches are the purple
  // family; seeded on the named swatches (Moveworks precedent).
  'Vanta': { primary: '#ac55ff', secondary: '#f8f4f3', accent: '#240642' },
  // Source: brandfetch.com/vanta.com brand page (claimed brand), named
  // swatches Vanta Purple / Vanta White / Vanta Dark Purple; same
  // company as Vanta, duplicate registry entry, same seed.
  'Vanta Inc.': { primary: '#ac55ff', secondary: '#f8f4f3', accent: '#240642' },
  // Source: brandfetch.com/vasion.com brand page, named swatches
  // International Orange / Tacao / Haiti; header names the FedRAMP High
  // print platform, registry offering Vasion Automate Fed; fallback
  // lettermark icon only.
  'Vasion': { primary: '#ff5100', secondary: '#f4a884', accent: '#201435' },
  // Source: brandfetch.com/vaultara.com brand page, palette stated in
  // its FAQ (no color names listed); medical image and file exchange
  // matches the registry offering, Vaultara Flare Services.
  'Vaultara, LLC': { primary: '#267f7c', secondary: '#75ffe7', accent: '#092c4a' },
  // Source: brandfetch.com/vbrick.com brand page, named swatches Picton
  // Blue / White / Ebony Clay; About describes the enterprise video
  // platform, the registry offering.
  'Vbrick Systems, Inc.': { primary: '#35c2f2', secondary: '#ffffff', accent: '#212934' },
  // Tranche 11 (Nov 15, 2026): the 33 remaining undecided vendors in
  // registry order after Vbrick Systems, Inc., from Veracode through
  // zLink, Inc. Of the 103 vendors on default palettes when this
  // tranche began, 70 were stayed-default decisions recorded in
  // tranches 1 to 10; they were skipped and not recounted, per the
  // standing rule. 29 moved to researched. With this tranche every
  // vendor in the registry carries a decision and the brand research
  // pass is complete. Stayed default on the record: Veridix, LLC
  // (brandfetch.com/veridix.com rejected: the page is titled for Emmes,
  // its parent group, and its palette is expressly stated as the Emmes
  // color palette under Emmes's name and icon, although its About
  // leads with Veridix and the eClinical platform that is the registry
  // offering; a palette expressly presented as the parent's own is not
  // seedable even at the vendor's domain, tranche 8 PSCS precedent; no
  // other citable source for Veridix's own colors found); Visionlink,
  // Inc. (no Brandfetch page at visionlink.org or visionlink.com, both
  // 404, and targeted searches surfaced no guidelines or listing
  // stating its colors as hex values); xAI (its only listing,
  // brandfetch.com/x.ai, states exactly two colors, #ffffff and
  // #000000; no third value citable, the accent never invented,
  // tranche 8 OpenAI precedent); XTec, Incorporated (its only listing,
  // brandfetch.com/xtec.com, states exactly two colors, #ffffff and
  // #1a2e43; no third value citable). Judgment calls recorded in the
  // per-entry comments: Verily Health seeded from the Verily Life
  // Sciences page at the vendor's own domain (same company); WalkMe,
  // Inc seeded from its own brand page although its wordmark carries
  // an 'an SAP company' signature; WidePoint Integrated Solutions
  // Corp. seeded from the parent WidePoint Corporation brand the
  // subsidiary carries; Vulcan Technologies, Inc. seeded from the
  // palette stated at vulcan.ai, the domain anchored by the company's
  // own trust center, whose About text is generic boilerplate naming
  // no other company. Seven seeds carry #000000 as a single
  // fallback-trio member with named, unique, identity-consistent
  // swatches (Verkada accent, Wallarm accent, Wellspring Worldwide
  // accent, WidePoint accent, Wraithwatch accent, Xerox secondary,
  // zLink accent): flagged per entry, tranche 5 Ex Libris precedent;
  // the fallback trio itself appears in none. Partial prose tension
  // recorded per entry for Veracode, Veritone, Inc. and Workiva
  // (tranche 7 Moveworks precedent). Five sources list four or more
  // colors (Verkada, WalkMe, Wolters Kluwer, Zeta Global, Zimperium):
  // the first three in listed order are seeded and the remainder noted
  // per entry.
  // Source: brandfetch.com/veracode.com brand page, named swatches
  // Dodger Blue / White / Bossanova; header and About describe the
  // application security platform, the registry offering (Veracode
  // Online Security Platform). Partial prose tension recorded: the
  // logo prose cites a bright yellow call-to-action color and a deep
  // navy canvas, neither among the stated swatches; seeded on the
  // stated palette (Moveworks precedent).
  'Veracode': { primary: '#00b9ff', secondary: '#ffffff', accent: '#613370' },
  // Source: brandfetch.com/verily.com brand page (Verily Life
  // Sciences), named swatches Elf Green / Cod Gray / White. Judgment:
  // the registry vendor Verily Health is the same company; the page at
  // its own domain presents its own brand, and its governed health
  // data platform is the registry offering family.
  'Verily Health': { primary: '#087a6a', secondary: '#1a1a1a', accent: '#ffffff' },
  // Source: brandfetch.com/veritone.com brand page, palette stated in
  // its FAQ (no color names listed); About names aiWARE, the registry
  // offering family. Partial prose tension recorded: the logo prose
  // cites vivid lime accents, not among the stated hex codes; seeded
  // on the stated palette (Moveworks precedent).
  'Veritone, Inc.': { primary: '#335491', secondary: '#f1f8fe', accent: '#0e1932' },
  // Source: brandfetch.com/verkada.com claimed brand page, named
  // swatches Chathams Blue / Elephant / Black; White #ffffff also
  // listed. Accent #000000 is a single fallback-trio member; swatches
  // named, unique, identity-consistent (Ex Libris precedent). About
  // describes cloud-managed physical security, the registry offering
  // (Verkada Command Platform).
  'Verkada Inc': { primary: '#105274', secondary: '#15374c', accent: '#000000' },
  // Source: brandfetch.com/vibrenthealth.com brand page, named
  // swatches Curious Blue / Anakiwa / Tangaroa; header and About
  // describe the digital health research platform built with the
  // National Institutes of Health, the registry offering.
  'Vibrent Health': { primary: '#1e91ca', secondary: '#a5edfc', accent: '#051f48' },
  // Source: brandfetch.com/virtru.com brand page, named swatches
  // Cornflower Blue / Heather / Congress Blue; About names the Data
  // Security Platform and the Trusted Data Format, the registry
  // offering.
  'Virtru': { primary: '#6aaae4', secondary: '#adbdcc', accent: '#004987' },
  // Source: brandfetch.com/virtualdojo.com brand page, palette stated
  // in its FAQ (no color names listed); About describes the AI
  // workspace for government contractors that works alongside existing
  // CRMs, the registry offering (VirtualDojo AI CRM).
  'VirtualDojo, Inc.': { primary: '#e03939', secondary: '#1f2937', accent: '#ffffff' },
  // Source: brandfetch.com/visiblethread.com brand page, named
  // swatches Cornflower Blue / White / Haiti; header names full-
  // lifecycle RFP intelligence, the registry offering.
  'VisibleThread': { primary: '#7654f5', secondary: '#ffffff', accent: '#0a0722' },
  // Source: brandfetch.com/visualvault.com brand page, palette stated
  // in its FAQ (no color names listed); About describes the cloud
  // content services platform, the registry offering (VisualVault
  // Cloud).
  'VisualVault LLC': { primary: '#55a333', secondary: '#79ace9', accent: '#19247b' },
  // Source: brandfetch.com/vlogicsystems.com brand page, named
  // swatches Tango / White / Blue Zodiac; header and About describe
  // facility management software, the registry offering (VLogicFM).
  'VLogic Systems, Inc.': { primary: '#f16f23', secondary: '#ffffff', accent: '#12254e' },
  // Source: brandfetch.com/vulcan.ai brand page, named swatches Tory
  // Blue / Aqua Island / Abbey. Judgment: vulcan.ai is the vendor's
  // own domain, anchored by its own trust center
  // (trust.vulcangov.app names security@vulcan.ai and the VulcanGov
  // service, the registry offering), and the page header states the
  // company's frontier-AI-to-government mission; the About text is
  // generic AI boilerplate that names no other company (tranche 7
  // Mycroft and tranche 10 Trenchant precedent). The
  // brandfetch.com/vulcantechnologies.com page is a different company
  // (fire-rated vents) whose About is boilerplate about a social
  // network; rejected, not used.
  'Vulcan Technologies, Inc.': { primary: '#154196', secondary: '#a2c7db', accent: '#4f5156' },
  // Source: brandfetch.com/walkme.com brand page, palette stated in
  // its FAQ, listing four values; the first three are seeded and Deep
  // Koamaru #090b3e is also listed. Judgment: the wordmark carries an
  // 'an SAP company' signature, but the page presents WalkMe's own
  // brand and palette at its own domain (tranche 10 Valimail
  // precedent); About describes the Digital Adoption Platform, the
  // registry offering (WalkMe DAP).
  'WalkMe, Inc': { primary: '#3c40fd', secondary: '#1eebb8', accent: '#ffffff' },
  // Source: brandfetch.com/wallarm.com brand page, named swatches
  // Chilean Fire / Blue Ribbon / Black. Accent #000000 is a single
  // fallback-trio member; swatches named, unique, identity-consistent
  // (Ex Libris precedent); fallback lettermark icon only. About
  // describes API and AI security, the registry offering (Wallarm
  // Federal Cloud).
  'Wallarm, Inc.': { primary: '#fc7303', secondary: '#4842ff', accent: '#000000' },
  // Source: brandfetch.com/wellspring.com brand page, named swatches
  // Blaze Orange / Royal Blue / Black. Accent #000000 is a single
  // fallback-trio member; swatches named, unique, identity-consistent
  // (Ex Libris precedent). About describes innovation management and
  // technology transfer software (Accolade, Flintbox), the registry
  // offering family.
  'Wellspring Worldwide, Inc.': { primary: '#ff6500', secondary: '#5350f0', accent: '#000000' },
  // Source: brandfetch.com/widepoint.com brand page (WidePoint
  // Corporation), named swatches Alizarin Crimson / Heather / Black.
  // Accent #000000 is a single fallback-trio member; swatches named,
  // unique, identity-consistent (Ex Libris precedent). Judgment:
  // parent brand; the registry vendor is the parent's Integrated
  // Solutions subsidiary and carries the corporate brand (tranche 10
  // Tyler Technologies Data & Insights precedent).
  'WidePoint Integrated Solutions Corp.': { primary: '#eb2429', secondary: '#b9c6d3', accent: '#000000' },
  // Source: brandfetch.com/willcotech.com brand page, named swatches
  // Dodger Blue / Portage / Governor Bay; header names CyberSTAR and
  // DoD 8140 compliance, the registry offering; fallback lettermark
  // icon only.
  'WillCo Tech': { primary: '#4368f8', secondary: '#9896f0', accent: '#323ea7' },
  // Source: brandfetch.com/wingswept.com brand page, named swatches
  // Rolling Stone / White / Orient; tags name investigator case
  // management software, the registry offering (Case Management &
  // Tracking System).
  'WingSwept': { primary: '#747b7f', secondary: '#ffffff', accent: '#005881' },
  // Source: brandfetch.com/wisedocs.com brand page, named swatches
  // Dodger Blue / Anakiwa / Ebony; About describes the medical record
  // review platform, the registry offering (Wisedocs for Government).
  'Wisedocs USA Inc.': { primary: '#2582ff', secondary: '#93c1ff', accent: '#0e1626' },
  // Source: brandfetch.com/workiva.com brand page, named swatches
  // Mantis / Old Lace / Mine Shaft; tags name the governance, risk
  // and compliance platform, the registry offering (Workiva
  // Platform). Partial prose tension recorded: the logo prose cites
  // bright blue accents, not among the stated swatches; seeded on the
  // stated palette (Moveworks precedent).
  'Workiva': { primary: '#66cc66', secondary: '#fcf4e7', accent: '#333333' },
  // Source: brandfetch.com/wolterskluwer.com brand page, palette
  // stated in its FAQ, listing four values; the first three are
  // seeded and White #ffffff is also listed. The registry offering
  // (TeamMate FedRAMP) is the vendor's own product.
  'Wolters Kluwer': { primary: '#85bc20', secondary: '#007ac3', accent: '#353535' },
  // Source: brandfetch.com/wraithwatch.com brand page, named swatches
  // Cerulean Blue / Wild Sand / Black. Accent #000000 is a single
  // fallback-trio member; swatches named, unique, identity-consistent
  // (Ex Libris precedent). About describes the adaptive cyber defense
  // platform and names FedRAMP High authorization in process, the
  // registry offering family.
  'Wraithwatch Corporation': { primary: '#2867b2', secondary: '#f5f5f5', accent: '#000000' },
  // Source: brandfetch.com/xerox.com brand page, palette stated in
  // its FAQ (no color names listed). Secondary #000000 is a single
  // fallback-trio member (Ex Libris precedent). About names managed
  // print services, the registry offering.
  'Xerox Corporation': { primary: '#d92231', secondary: '#000000', accent: '#ffffff' },
  // Source: brandfetch.com/xfinion.com brand page, named swatches
  // Orange Peel / Seagull / Biscay; header and About describe the
  // federal systems integrator, the registry vendor; fallback
  // lettermark icon only.
  'Xfinion Inc.': { primary: '#e5a000', secondary: '#73b3e7', accent: '#1b3a6b' },
  // Source: brandfetch.com/yello.co brand page, named swatches
  // Cerulean / Peach Orange / Blue Lagoon; About names government
  // recruiting and the FedRAMP-authorized platform, the registry
  // offering (Yello Government).
  'Yello Dba Recsolu Inc': { primary: '#06afd1', secondary: '#ffd595', accent: '#04718a' },
  // Source: brandfetch.com/zeroeyes.com brand page, named swatches
  // Malibu / White / Cod Gray; header and About describe AI gun
  // detection, the registry offering (ZEF).
  'ZeroEyes Inc': { primary: '#609fff', secondary: '#ffffff', accent: '#121212' },
  // Source: brandfetch.com/zetaglobal.com brand page, palette stated
  // in its FAQ, listing four values; the first three are seeded and
  // Stratos #00003d is also listed. About describes the data-driven
  // marketing platform company, the registry offering (Zeta Marketing
  // Platform).
  'Zeta Global Corp.': { primary: '#bb2676', secondary: '#035cd4', accent: '#ffffff' },
  // Source: brandfetch.com/zimperium.com brand page, named swatches
  // Orange / Big Stone / White; Black Pearl #041423 also listed.
  // About names Mobile Endpoint Security, the registry offering.
  'Zimperium': { primary: '#ff5926', secondary: '#1b3247', accent: '#ffffff' },
  // Source: brandfetch.com/zlti.com brand page (ZL Tech), palette
  // stated in its FAQ (no color names listed); About names the
  // unified architecture for information governance, the registry
  // offering (ZL Unified Archive).
  'ZL Technologies, Inc.': { primary: '#c52040', secondary: '#abcae7', accent: '#202135' },
  // Source: brandfetch.com/zlinkcorp.com brand page, named swatches
  // Blue Ribbon / Wild Sand / Black. Accent #000000 is a single
  // fallback-trio member; swatches named, unique, identity-consistent
  // (Ex Libris precedent). Header describes the facilities platform,
  // the registry offering (zLinkFM); the About section carries
  // company metadata only (tranche 7 Mycroft precedent).
  'zLink, Inc.': { primary: '#283fff', secondary: '#f5f5f5', accent: '#000000' }
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
