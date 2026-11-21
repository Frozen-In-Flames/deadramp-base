# DeadRamp Base: NIST SP 800-53 Control Matrix

A tailored self-assessment of DeadRamp Base against the control baselines of
NIST SP 800-53, Revision 5, as selected for the Low impact level in
NIST SP 800-53B.

## 1. Purpose and scope

This document records, control by control, how the security and privacy
controls of the SP 800-53 Low baseline apply to DeadRamp Base, and the
status of each control given the concrete architecture of the system. It
exists for three reasons. First, the subject of DeadRamp Base is the
federal authorization process itself: the environment models the FedRAMP
Marketplace, and a project that renders authorization records as
architecture should be able to state its own control posture with the
same precision. Second, the development of DeadRamp and DeadRamp Base is
conducted under the secure development practices of NIST SP 800-218 (the
Secure Software Development Framework), adopted by the project's Merge
Rule, and this matrix is the corresponding operational record. Third,
several properties of the system that are usually asserted informally
(data minimization, vendored dependencies, verified deploys) are here
stated as control claims with evidence, so that each claim can be checked
against the repository.

This is a self-assessment prepared by the developer. It is not an
assessment by an accredited assessor, and it supports no authorization
decision. Section 6 states the limits of the document in full.

## 2. System characterization

The statuses in Section 4 rest on the following facts of the system, each
of which is verifiable in the repository.

1. **Form.** DeadRamp Base is a static web application: HTML, CSS, and
   JavaScript served as files, with all execution performed in the
   visitor's browser. There is no server-side component, no application
   programming interface operated by the project, and no database.
2. **Hosting.** The application is served by GitHub Pages from the
   public repository Frozen-In-Flames/deadramp-base. Transport security
   is the platform's HTTPS service. The platform does not permit the
   site operator to set custom response headers.
3. **Data.** The system processes no personal data. It offers no
   accounts, no registration, no forms that transmit data, no analytics,
   and no telemetry. The only information persisted anywhere is the
   visitor's own display and accessibility preferences, stored by the
   application in the visitor's own browser storage, on the visitor's
   own device. Terminal session state is held in memory for the
   duration of a visit and is disposed of when the visitor leaves a
   building.
4. **Content.** The modeled content is a clean-room rendition of public
   FedRAMP Marketplace information: 674 vendors, 781 offerings, and 101
   reference builds, generated into a single catalog file
   (data/base-catalog.json) by an exporter whose fidelity to the source
   records is proven by automated tests, including mutation negative
   controls.
5. **Executable content.** Each room terminal executes the corresponding
   DeadRamp reference build, in the visitor's browser, through a
   vendored Python runtime (Pyodide version 0.26.4, vendored in version
   0.4.0 of the Base after a field report showed that dependence on a
   content delivery network caused live launches to fail on a visitor's
   device). The 3D library (Three.js, release 160) is likewise vendored.
   The site loads no third-party subresources at runtime.
6. **Integrity records.** The catalog carries a SHA-256 hash for each of
   the 854 files that make up the 101 reference builds, recorded at
   export time and proven against the source files by the exporter's
   fidelity tests. As of this conformance pack, the application also
   verifies each bundle file's hash at load time, in the browser,
   before the build is permitted to execute (see SI-7).
7. **Release discipline.** Every release is gated on a suite of
   automated verification programs (exporter fidelity, principal
   behavior, walking and climbing, platform structures, WebXR boundary,
   terminal launch, and accessibility suites), and the files served by
   the hosting platform are byte-compared against the released tree
   after each deployment. Release notes record what changed, why, and
   the measured verification results.

## 3. Tailoring methodology

The starting point is the Low baseline of SP 800-53B. Tailoring proceeds
from the system boundary established in Section 2: the system consists
of the static artifact and its development process; the hosting
platform's infrastructure and the visitor's device are outside the
boundary, and controls whose subject matter lies wholly in one of those
domains are marked accordingly. Controls are treated at the level of the
individual control where the system presents a distinct fact, and at
family level where a family shares a single disposition (facility
controls, media controls, and the policy and procedures controls). The
PM family is not addressed: program management controls are
organization-level controls that SP 800-53B does not select into
baselines. One control, PL-8, is included by tailoring addition although
it is not selected in the Low baseline, because the architecture record
it calls for exists and is material to several other statuses.

Each control is assigned exactly one status:

- **Satisfied by the build**: the control's objective is met by the
  design, content, or development process of DeadRamp Base itself.
- **Inherited from the hosting platform**: the control's objective is
  met by GitHub Pages and the infrastructure beneath it, on which the
  system depends.
- **Partially satisfied**: the objective is met in part; the rationale
  states what is met and what is not.
- **Not applicable**: the control's subject matter does not exist within
  the system boundary, for the reason stated.

## 4. Control matrix

### Cross-cutting

| Control | Status | Rationale |
|---|---|---|
| Policy and procedures controls (AC-1, AT-1, AU-1, CA-1, CM-1, CP-1, IA-1, IR-1, MA-1, MP-1, PE-1, PL-1, PS-1, PT-1, RA-1, SA-1, SC-1, SI-1, SR-1) | Partially satisfied | Written procedures exist in the repository and are demonstrably followed: the project plan (docs/BASE-PLAN.md), the layout and architecture record (LAYOUT.md), per-release notes stating changes and their reasons, and this matrix. They are the procedures of a single-maintainer project, not the formal policy suite of an organization, and are not represented as such. |

### Access Control (AC)

| Control | Status | Rationale |
|---|---|---|
| AC-2 Account Management | Not applicable | The system has no accounts. No identity store, registration function, or account lifecycle exists on either side of the boundary. |
| AC-3 Access Enforcement | Not applicable | The system enforces no access restrictions because it holds no controlled resource: every file it serves is public information published for unauthenticated distribution. |
| AC-7 Unsuccessful Logon Attempts | Not applicable | No logon function exists. |
| AC-11 Device Lock | Not applicable | No authenticated session exists that a device lock would protect. Locking of the visitor's device is a function of the visitor's own platform, outside the boundary. |
| AC-14 Permitted Actions without Identification or Authentication | Satisfied by the build | The entire function set of the system (navigation, record inspection, terminal sessions, settings) is deliberately designated for use without identification or authentication, and the designation is documented in the project plan and in Section 2 of this matrix. |
| AC-17 Remote Access | Not applicable | The system accepts no inbound connections and provides no remote access capability. It is a static file set retrieved over HTTPS at the visitor's initiative. |
| AC-18 Wireless Access | Not applicable | The system operates no network infrastructure of any kind. |
| AC-20 Use of External Systems | Satisfied by the build | The application depends on no external system at runtime: all libraries and the Python runtime are vendored into the repository (Section 2, fact 5), and the served pages reference no third-party subresources. The only external dependency in the life cycle is the hosting platform itself, addressed under the inherited controls. |

### Awareness and Training (AT)

| Control | Status | Rationale |
|---|---|---|
| AT-2 Literacy Training and Awareness | Not applicable | The system has no organizational users whose training could be administered. Visitors are members of the public using a published artifact; the in-application help system and the accessibility statement inform them of what the system does, but no training obligation arises. |

### Audit and Accountability (AU)

| Control | Status | Rationale |
|---|---|---|
| AU-2 Event Logging | Partially satisfied | No server exists to generate logs of visitor activity, and by design the system records nothing about visitors: there is no telemetry to log. Two audit records do exist. Development-side, the complete change history is retained in version control with per-release records. Visitor-side, each reference build carries its own audit log implementation, which executes within the terminal session and is disposed of with the session, as the build's own design specifies. |
| AU-6 Audit Record Review, Analysis, and Reporting | Not applicable | No audit records of system use are generated (see AU-2), so there is no body of records to review. Development records are reviewed as part of the release process under CM-3. |
| AU-8 Time Stamps | Not applicable | The system generates no audit records requiring time stamps. Development records carry the time stamps of the version control platform. |
| AU-11 Audit Record Retention | Not applicable | No visitor audit records exist to retain. The development record is retained without limit in the public repository, which is the only retention the system performs. |

### Assessment, Authorization, and Monitoring (CA)

| Control | Status | Rationale |
|---|---|---|
| CA-2 Control Assessments | Satisfied by the build | Assessment is continuous with development: seven automated verification suites assess the behavior of every release, the exporter fidelity tests prove the catalog against its sources with mutation negative controls, a measured accessibility audit was performed against version 0.4.0 and its findings implemented in version 0.5.0, and this matrix assesses the control posture. Results are recorded in the release notes. |
| CA-5 Plan of Action and Milestones | Partially satisfied | Known deficiencies are recorded with their dispositions: the limitations section of this matrix (Section 5), the stated limits in each set of release notes, and the audit findings register. No formal plan of action and milestones system is operated, and remediation is sequenced by the maintainer rather than by milestone dates. |
| CA-6 Authorization to Operate | Not applicable | No authorizing official exists for this system, and none is sought. The system is not operated on behalf of any government agency (see Section 6). |
| CA-7 Continuous Monitoring | Partially satisfied | Monitoring is release-time rather than continuous: the full verification suites re-run for every release, and the served files are byte-compared against the released tree after every deployment. Runtime monitoring of visitor activity is deliberately absent (see SI-4). |

### Configuration Management (CM)

| Control | Status | Rationale |
|---|---|---|
| CM-2 Baseline Configuration | Satisfied by the build | The tagged release tree is the baseline configuration. Conformance of the deployment to the baseline is not assumed: after each release, the principal served files are fetched from the hosting platform and byte-compared against the tree. The catalog component of the baseline is itself deterministic: regeneration is proven byte-identical by the fidelity tests. |
| CM-3 Configuration Change Control | Satisfied by the build | All change reaches the public site through version control and a test-gated release: no release is published unless every verification suite passes, and each release is recorded with notes stating what changed and why. There is no path by which the served artifact can be altered outside this process, short of compromise of the maintainer's platform account (see Section 5). |
| CM-6 Configuration Settings | Satisfied by the build | The application has no operator-configurable settings on any server, because there is no server. Its configuration is its source. Visitor-facing settings are confined to comfort and accessibility preferences, stored on the visitor's own device under the visitor's control. |
| CM-7 Least Functionality | Satisfied by the build | The system provides one function set and nothing else: it opens no ports, exposes no administrative interface, accepts no uploads, and executes no code other than its own first-party content and the reference builds a visitor explicitly launches. |
| CM-8 System Component Inventory | Satisfied by the build | The inventory is machine-readable and complete at two levels: the catalog enumerates every modeled component (674 vendors, 781 offerings, 101 builds, 854 bundle files with hashes), and the vendored dependency set is enumerated in the repository with versions recorded (Three.js release 160; Pyodide version 0.26.4). |
| CM-11 User-Installed Software | Not applicable | Visitors install nothing. The application executes entirely within the browser sandbox from served files. |

### Contingency Planning (CP)

| Control | Status | Rationale |
|---|---|---|
| CP-2 Contingency Plan | Partially satisfied | The recovery capability is structural: the complete system is reproducible from the public repository, and restoration after a hosting failure consists of redeploying the same tree to any static host, a path the verification suites exercise routinely by serving the tree from a local server. No formal contingency plan document is maintained. |
| CP-4 Contingency Plan Testing | Not applicable | No contingency mechanism distinct from redeployment exists to be tested. The redeployment path itself is exercised at every release (see CP-2). |
| CP-6 Alternate Storage | Inherited from the hosting platform | Storage and replication of the served content are provided by the hosting platform's infrastructure. The authoritative copy additionally exists in the public git repository, whose distributed history is itself a replicated store. |
| CP-7 Alternate Processing Site | Inherited from the hosting platform | Service is delivered from the hosting platform's distributed infrastructure. Independently of the platform, the static tree requires no platform-specific capability and can be served from any static host without modification. |

### Identification and Authentication (IA)

| Control | Status | Rationale |
|---|---|---|
| IA-2 Identification and Authentication (Organizational Users) | Not applicable | The system identifies and authenticates no one; it has no organizational users. (Outside the application boundary, access to the repository itself is controlled by the hosting platform's account authentication, with two-factor authentication enabled on the maintainer account; that control is the platform's.) |
| IA-5 Authenticator Management | Not applicable | The system issues, stores, and manages no authenticators. |
| IA-11 Re-authentication | Not applicable | No sessions exist that could require re-authentication. |

### Incident Response (IR)

| Control | Status | Rationale |
|---|---|---|
| IR-4 Incident Handling | Partially satisfied | The handling capability matches the attack surface: for a static artifact, response consists of correcting or withdrawing the deployment through the repository, which the maintainer can do at any time, and the integrity controls (SI-7, CM-2) bound the class of incident that could require it. No incident response team or formal handling process exists. |
| IR-5 Incident Monitoring | Partially satisfied | Repository and hosting security events are surfaced to the maintainer by the platform's notification mechanisms. No dedicated incident monitoring is operated, and the application generates no telemetry from which incidents could be detected in use (see SI-4). |
| IR-8 Incident Response Plan | Not applicable | No formal incident response plan document is maintained for a public static artifact. The handling capability that a plan would describe is recorded under IR-4. |

### Maintenance (MA)

| Control | Status | Rationale |
|---|---|---|
| MA-2 Controlled Maintenance | Inherited from the hosting platform | All maintenance of serving infrastructure is performed by the hosting platform. The application itself has no maintenance mode and no maintenance access path; change to the application is development, governed under CM-3. |
| MA-4 Nonlocal Maintenance | Inherited from the hosting platform | No maintenance sessions to the application exist. Hosting maintenance is conducted by the platform under its own controls. |

### Media Protection (MP)

| Control | Status | Rationale |
|---|---|---|
| MP-6 Media Sanitization | Not applicable | The system handles no physical media and stores no data that could require sanitization. |
| MP-7 Media Use | Not applicable | No removable media is used by the application at any point in its life cycle. |

### Physical and Environmental Protection (PE)

| Control | Status | Rationale |
|---|---|---|
| PE-6 Monitoring Physical Access | Inherited from the hosting platform | Physical access to the serving infrastructure is controlled and monitored by the hosting platform's data center operations. The project operates no facility. |
| PE-9, PE-11, PE-13, PE-14 Power, Fire, and Environmental Controls | Inherited from the hosting platform | Power equipment, emergency power, fire protection, and environmental controls for the serving infrastructure are provided by the hosting platform's facilities. |

### Planning (PL)

| Control | Status | Rationale |
|---|---|---|
| PL-2 System Security and Privacy Plans | Partially satisfied | The security documentation of the system consists of this matrix, the project plan (docs/BASE-PLAN.md), the architecture record (LAYOUT.md), and the release notes. Together they describe the system, its boundaries, and its control posture. No plan in the federal format is maintained, because the system is not a federal system (see Section 6). |
| PL-4 Rules of Behavior | Not applicable | There are no accounts or gated functions for which rules of behavior would be acknowledged. Use of the code is governed by its license; use of the hosted site is subject to the hosting platform's terms. |
| PL-8 Security and Privacy Architecture (included by tailoring addition) | Satisfied by the build | The architecture is documented (LAYOUT.md; docs/BASE-PLAN.md) and embodies the principles this matrix relies on: data minimization by construction (no collection is possible in a system with no receiver), least functionality, client-side-only execution, and mediation of executed third-party-modeled code by integrity verification. |

### Personnel Security (PS)

| Control | Status | Rationale |
|---|---|---|
| PS-4 Personnel Termination; PS-5 Personnel Transfer | Not applicable | The project has a single maintainer and no personnel processes. Access to the system is bound to one platform account; there are no additional individuals whose access would require revocation or review on a personnel change. |
| PS-7 External Personnel Security | Inherited from the hosting platform | Personnel security for hosting operations is the responsibility of the hosting platform under its own compliance program. |

### PII Processing and Transparency (PT)

| Control | Status | Rationale |
|---|---|---|
| PT-2 Authority to Process PII; PT-3 PII Processing Purposes | Not applicable | The system processes no personally identifiable information, and therefore requires no authority and states no processing purpose. It collects nothing: no accounts, no submissions, no analytics, no application-set cookies. The single data store it touches is the visitor's own browser storage, holding the visitor's own display preferences on the visitor's own device (see Section 2, fact 3). |

### Risk Assessment (RA)

| Control | Status | Rationale |
|---|---|---|
| RA-3 Risk Assessment | Partially satisfied | Risk is assessed qualitatively and in writing at the points where it concentrates: the measured accessibility audit of version 0.4.0, the limitations recorded in Section 5 of this matrix, and the stated limits in the release notes. No formal organizational risk assessment process or risk register is operated. |
| RA-5 Vulnerability Monitoring and Scanning | Partially satisfied | The vulnerability surface is deliberately small and enumerable: two vendored components at pinned, recorded versions, and first-party code assessed by the verification suites at every release. The platform provides vulnerability and secret scanning signals for the repository. No runtime scanning is applicable to a static artifact, and dependency versions are reviewed at release time rather than continuously. |

### System and Services Acquisition (SA)

| Control | Status | Rationale |
|---|---|---|
| SA-3 System Development Life Cycle | Satisfied by the build | Development follows the Secure Software Development Framework (NIST SP 800-218), adopted through the project's Merge Rule: test-first construction, fidelity gates with negative controls, and releases that do not proceed on a failing suite. The life cycle is documented in the project plan. |
| SA-4 Acquisition Process | Not applicable | Nothing is acquired. The system is developed by the maintainer from first-party code and two open source components, whose treatment is recorded under SR-3 and SR-11. |
| SA-5 System Documentation | Satisfied by the build | Administrator and user documentation is published in the repository: the README (operation and regeneration), LAYOUT.md (architecture and layout mathematics), docs/BASE-PLAN.md (design constitution), per-version release notes, and in-application help, directory, and accessibility statement for visitors. |
| SA-8 Security and Privacy Engineering Principles | Satisfied by the build | The governing principles are applied in the architecture and named in it: data minimization (no collection), least functionality (CM-7), least privilege (the application requests no device permissions beyond what a feature the visitor invokes requires), and fail-safe defaults (SI-17). |
| SA-10 Developer Configuration Management | Satisfied by the build | All source is under version control; releases are tagged; and the deployed artifact is verified against the tagged tree by byte comparison after every deployment (see CM-2). |
| SA-11 Developer Testing and Evaluation | Satisfied by the build | Seven automated suites test the system before any release, including security-relevant negative controls: a mutated catalog field must change exactly one record, a tampered bundle file must be refused at load, and a fabricated terminal request must be answered as unrecorded rather than invented. Suite results are recorded per release. |
| SA-15 Development Process, Standards, and Tools | Satisfied by the build | The development process implements SP 800-218 practices (see SA-3) and is built on open standards throughout: HTML, WebGL, and WebXR for presentation, JavaScript for the application, and Python for the executed reference builds. Tooling is the version control and verification apparatus described under SA-10 and SA-11. |
| SA-22 Unsupported System Components | Partially satisfied | No component is used past the end of its support in a way the project depends on silently; however, the two vendored components are pinned to recorded versions (Three.js release 160; Pyodide version 0.26.4) that are not the current releases of their projects. The exposure is bounded (neither component receives network input in this architecture beyond the application's own files) and is recorded here rather than remediated by continuous upgrade, which the release process does not currently perform. |

### System and Communications Protection (SC)

| Control | Status | Rationale |
|---|---|---|
| SC-5 Denial of Service Protection | Inherited from the hosting platform | Availability protection for the serving path is provided by the hosting platform's infrastructure. The application's own resource consumption falls on the visitor's device, at the visitor's initiative; it presents no shared server resource that one visitor could exhaust for others. |
| SC-7 Boundary Protection | Partially satisfied | The operative boundaries are the browser sandbox and the same-origin policy, and the application minimizes what crosses them: it loads no third-party subresources and makes no cross-origin requests at runtime. The boundary is incomplete at one layer: the hosting platform does not permit operator-set response headers, so header-based protections (a content security policy, strict transport security policy beyond the platform default, and related headers) cannot be applied. See Section 5. |
| SC-8 Transmission Confidentiality and Integrity; SC-8(1) Cryptographic Protection | Inherited from the hosting platform | All content is served over HTTPS, with TLS provided and terminated by the hosting platform. The application transmits no confidential information in any case; the protected interest is the integrity of the served artifact, which is additionally addressed under SI-7. |
| SC-12 Cryptographic Key Establishment and Management | Inherited from the hosting platform | TLS keys are established, stored, and managed by the hosting platform. The application manages no cryptographic keys; its one cryptographic operation is unkeyed hashing (see SC-13). |
| SC-13 Cryptographic Protection | Satisfied by the build | The only cryptography the application itself performs is SHA-256, the FIPS 180-4 hash function, used for integrity verification of executable bundle files at load time and of the catalog at export time. No algorithm is used for confidentiality, and no non-approved algorithm is used anywhere. |
| SC-18 Mobile Code | Satisfied by the build | All mobile code executed by the system is first-party, versioned, and released through the gated process of CM-3. The subset that models third-party systems (the reference builds) is additionally integrity-verified at load (SI-7) and executes only inside the browser sandbox and the vendored interpreter. The application loads and executes no code from any third-party origin. |
| SC-28 Protection of Information at Rest | Satisfied by the build | The system stores no information at rest on any server. The only persisted data are the visitor's own non-sensitive display preferences in the visitor's own browser, and terminal session state that exists only in memory and is disposed of when the visitor leaves a building. |
| SC-39 Process Isolation | Satisfied by the build | Execution is isolated by construction: the application runs inside the browser's sandboxed renderer process, and each reference build executes inside the vendored Python interpreter with its transport substituted in-process, so the builds hold no sockets and no access to the visitor's file system. Session state is partitioned per room and disposed of on exit. |

### System and Information Integrity (SI)

| Control | Status | Rationale |
|---|---|---|
| SI-2 Flaw Remediation | Partially satisfied | Defects are remediated through the test-gated release process, with root causes recorded in the release notes (for example, the ramp surface shading defect corrected in version 0.3.13 and the recorded-surface fallback defect corrected in version 0.4.0). Remediation priority and timing are the maintainer's; no organizational remediation timelines bind the project. |
| SI-3 Malicious Code Protection | Partially satisfied | There is no server to protect. The corresponding exposure is tampered content reaching visitors, and it is addressed at three points: the catalog's hashes are proven at export, the deployment is byte-compared after release, and executable bundles are hash-verified in the visitor's browser at load, with refusal on mismatch (SI-7). The hosting platform applies its own protections to stored content. No endpoint protection is or can be operated for visitors' devices. |
| SI-4 System Monitoring | Partially satisfied | Monitoring is limited to platform-provided signals concerning the repository and the hosting account. Application-level monitoring of use is deliberately not performed: the system collects no telemetry, a privacy property recorded in Section 2 that forecloses this control's usual mechanism. The trade-off is accepted and stated here rather than resolved silently. |
| SI-5 Security Alerts, Advisories, and Directives | Partially satisfied | Advisories affecting the hosting platform and the repository are surfaced to the maintainer by the platform. No separate advisory intake process exists. |
| SI-7 Software, Firmware, and Information Integrity; SI-7(1) Integrity Checks; SI-7(7) Integration of Detection and Response | Satisfied by the build | Integrity is verified at every transition. At export, the fidelity tests prove all 854 bundle file hashes against the source files. At deployment, served files are byte-compared against the released tree. At load, the application fetches each bundle file as bytes, computes its SHA-256 with the browser's SubtleCrypto interface, and compares it against the hash recorded in the catalog before the build is staged for execution. Detection is integrated with response: on any mismatch the live launch is refused, the terminal falls back to the build's recorded surface, and the transcript states the integrity failure and names the file. Where SubtleCrypto is unavailable (a non-secure context), the session states that verification is unavailable rather than claiming a check that did not run. Both paths are proven by the launch verification suite, including a tampered-file negative control. |
| SI-10 Information Input Validation | Satisfied by the build | Terminal input is parsed against a fixed command grammar, and requests are executed by each reference build's own validation and authorization code, unmodified. Input the grammar does not recognize is rejected with an explicit message, and requests with no recorded behavior in a recorded session are answered as unrecorded: in neither mode is output fabricated. These behaviors are checked by the launch suite, including a nonsense command and an unknown route. |
| SI-11 Error Handling | Satisfied by the build | Errors surface as deliberate, bounded messages that state what failed and what the visitor is seeing instead: fallback explanations in terminal headers and transcripts (with platform error text truncated to 160 characters), unrecorded-request answers, and the integrity refusal message. The system holds no credentials or personal data that an error message could disclose. |
| SI-12 Information Management and Retention | Not applicable | The system retains no user information for which a retention schedule could apply. The catalog is a publication of public records, not a record system containing personal data. |
| SI-16 Memory Protection | Not applicable | The application deploys no native executable code outside the browser's managed runtimes. Memory protection is a property of the visitor's browser and operating system, outside the system boundary. |
| SI-17 Fail-safe Procedures | Satisfied by the build | Failure modes degrade toward safety and candor. A live launch that cannot complete, or that is refused on integrity grounds, degrades to the build's recorded surface with the reason stated in the transcript. A request that cannot be answered from real behavior is answered as unrecorded. No failure path fabricates output or presents a substitute as the genuine article. |

### Supply Chain Risk Management (SR)

| Control | Status | Rationale |
|---|---|---|
| SR-3 Supply Chain Controls and Processes; SR-5 Acquisition Strategies, Tools, and Methods | Satisfied by the build | The supply chain is deliberately reduced to two open source components, each vendored into the repository at a pinned, recorded version rather than fetched at build or run time, and the 854 executable bundle files derived from the project's own source and hashed at export. The vendored Python runtime was verified byte-identical to its published distribution at vendoring time. No other component enters the artifact. |
| SR-6 Supplier Assessments and Reviews | Not applicable | There are no suppliers in a contractual sense. The provenance and authenticity of the two open source components are addressed under SR-3 and SR-11 rather than by supplier assessment. |
| SR-11 Component Authenticity | Satisfied by the build | Authenticity of components is established by cryptographic comparison at three points (export, deployment, and load; see SI-7), and the counterfeit path that matters for this system, a served file differing from its recorded hash, is detected and refused in the visitor's browser before execution. |
| SR-12 Component Disposal | Not applicable | No component holding organizational or personal data is disposed of. Superseded code remains in public version history by design, and it contains no sensitive data. |

## 5. Limitations and hosting constraints

The following limitations are stated plainly, with the change that would
resolve each. None of them is remediable by further work within the
present hosting arrangement.

1. **Custom security headers cannot be set.** GitHub Pages does not
   permit the operator to configure response headers. A content
   security policy, an operator-set Strict-Transport-Security header,
   X-Content-Type-Options, Referrer-Policy, and Permissions-Policy
   therefore cannot be applied to the served site, and SC-7 is partial
   in consequence. The hosting change that satisfies this limitation is
   migration of the static tree, unmodified, to a host or content
   delivery configuration that permits response header control.
2. **No server-side logging or monitoring is possible.** A static host
   provides the operator no access logs for the site, and the
   application deliberately collects no telemetry. AU-2, IR-5, and SI-4
   are partial in consequence. Resolving this limitation in the usual
   way would require introducing the data collection the architecture
   exists to avoid; it is recorded as an accepted trade-off, not a
   defect awaiting repair.
3. **Deployment integrity rests on one platform account.** The control
   that stands between the public and an unauthorized deployment is the
   maintainer's GitHub account, protected by two-factor authentication.
   Compromise of that account would defeat CM-3 until detected. The
   byte-comparison step after each release detects divergence from the
   released tree but is not continuous. A multi-maintainer review
   requirement on the repository would reduce this exposure.
4. **Vendored components are pinned, not current.** Three.js release
   160 and Pyodide version 0.26.4 are recorded, verified versions, and
   are not the current releases of their projects (see SA-22). A
   scheduled dependency review at each release, with upgrades taken
   through the full verification suites, would close this gap.
5. **In-headset content is visual only.** WebXR provides no assistive
   technology channel, so the accessibility provisions of version 0.5.0
   (directory mode, announcements, keyboard operation) apply to the
   flat-screen presentation. This is a platform limitation, recorded in
   the application's own accessibility statement.

## 6. Statement of status

DeadRamp Base is not a federal information system. It is a privately
developed, publicly available model of public information, built by
Frozen In Flames. It is not authorized to operate on behalf of any
federal agency, it processes no federal data, and **it claims no FedRAMP
authorization, provisional or otherwise, and no authorization of any
other kind**. The vendors and offerings it models are identified from
the public FedRAMP Marketplace record; the model is not affiliated with
or endorsed by any vendor, and it is not affiliated with the FedRAMP
program. This matrix applies the vocabulary and discipline of
SP 800-53 to the system's own engineering because the project's subject
matter warrants that precision, and for no other reason. No statement in
this document should be read as a claim of compliance certification by
NIST, by the FedRAMP Program Management Office, or by any assessment
organization.

## References

- NIST SP 800-53, Revision 5, *Security and Privacy Controls for
  Information Systems and Organizations*.
- NIST SP 800-53B, *Control Baselines for Information Systems and
  Organizations* (Low baseline selection).
- NIST SP 800-218, *Secure Software Development Framework (SSDF)
  Version 1.1*.
- FIPS Publication 180-4, *Secure Hash Standard*.
- DeadRamp Base repository: README.md (operation and regeneration),
  LAYOUT.md (architecture), docs/BASE-PLAN.md (design constitution and
  Merge Rule), and the per-version release notes recording verification
  results.
