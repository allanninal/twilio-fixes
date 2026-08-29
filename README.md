# Twilio Fixes

Read-only Python and Node.js scripts that find Twilio problems through the API — numbers left on demo TwiML, unregistered 10DLC campaigns, webhooks pointing nowhere and messages filtered by carriers. They report and print the repair; they never write.

Every script here is read only. They hold a credential to a live account, so none of them writes: each one reads through the API, reports exactly what is wrong, and prints the repair for you to run.

By **[Allan Niñal](https://github.com/allanninal)** — AI Solutions Engineer. I build AI powered tools, data products, and AWS automation.
Full write ups with diagrams for each fix live at **[allanninal.dev/twilio](https://www.allanninal.dev/twilio/)**.

[![Follow on GitHub](https://img.shields.io/github/followers/allanninal?label=Follow%20%40allanninal&style=social)](https://github.com/allanninal)
## The fixes

- [an approved brand with no trust score is throttled to the floor](./a2p-brand-missing-secondary-vetting/) — https://www.allanninal.dev/twilio/a2p-brand-missing-secondary-vetting/
- [an A2P brand stuck at FAILED blocks every campaign under it](./a2p-brand-registration-failed/) — https://www.allanninal.dev/twilio/a2p-brand-registration-failed/
- [an A2P brand parked at PENDING for weeks with no callback](./a2p-brand-stuck-pending-review/) — https://www.allanninal.dev/twilio/a2p-brand-stuck-pending-review/
- [a SUSPENDED brand suspends every campaign underneath it](./a2p-brand-suspended/) — https://www.allanninal.dev/twilio/a2p-brand-suspended/
- [brand failed 30799: the EIN does not match the legal name](./a2p-brand-tax-id-legal-name-mismatch/) — https://www.allanninal.dev/twilio/a2p-brand-tax-id-legal-name-mismatch/
- [an a2p campaign parked at IN_PROGRESS is not a live campaign](./a2p-campaign-stuck-in-progress/) — https://www.allanninal.dev/twilio/a2p-campaign-stuck-in-progress/
- [a2p campaign is FAILED and errors[] names the rejected field](./a2p-campaign-vetting-failed/) — https://www.allanninal.dev/twilio/a2p-campaign-vetting-failed/
- [an alphanumeric sender ID is unregistered where you send](./alphanumeric-sender-id-unregistered/) — https://www.allanninal.dev/twilio/alphanumeric-sender-id-unregistered/
- [no API keys exist, so the auth token is the credential](./auth-token-used-instead-of-api-key/) — https://www.allanninal.dev/twilio/auth-token-used-instead-of-api-key/
- [the balance is one busy hour from a 20005 suspension](./balance-below-safety-floor/) — https://www.allanninal.dev/twilio/balance-below-safety-floor/
- [error 21617: the rendered message body exceeds 1600 chars](./body-exceeds-1600-chars-21617/) — https://www.allanninal.dev/twilio/body-exceeds-1600-chars-21617/
- [carrier filtering drops your SMS silently with error 30007](./carrier-filtered-messages-30007/) — https://www.allanninal.dev/twilio/carrier-filtered-messages-30007/
- [a conversation webhook with no URL fails every event: 50369](./conversations-webhook-url-missing/) — https://www.allanninal.dev/twilio/conversations-webhook-url-missing/
- [recycled numbers send OTPs to whoever owns them now](./deactivated-number-recycling/) — https://www.allanninal.dev/twilio/deactivated-number-recycling/
- [Dial rejected with 13214 on a passed-through caller ID](./dial-invalid-caller-id-13214/) — https://www.allanninal.dev/twilio/dial-invalid-caller-id-13214/
- [US and Canadian numbers with no registered E911 address](./emergency-address-unregistered/) — https://www.allanninal.dev/twilio/emergency-address-unregistered/
- [a failed Event Streams sink drops events and nothing says so](./event-streams-sink-failed/) — https://www.allanninal.dev/twilio/event-streams-sink-failed/
- [Fraud Guard blocked the prefix, so real users get 60410](./fraud-guard-blocking-prefix/) — https://www.allanninal.dev/twilio/fraud-guard-blocking-prefix/
- [a voice-only From number fails every SMS with error 21606](./from-number-not-sms-capable/) — https://www.allanninal.dev/twilio/from-number-not-sms-capable/
- [phone numbers with no traffic still bill every month](./idle-phone-numbers-billed/) — https://www.allanninal.dev/twilio/idle-phone-numbers-billed/
- [inbound SMS disappears into a number with no sms_url](./inbound-webhook-black-hole/) — https://www.allanninal.dev/twilio/inbound-webhook-black-hole/
- [SMS to a landline fails with 30006 and retrying never helps](./landline-destination-30006/) — https://www.allanninal.dev/twilio/landline-destination-30006/
- [messages stay queued or accepted and never reach a final state](./messages-stuck-queued-or-accepted/) — https://www.allanninal.dev/twilio/messages-stuck-queued-or-accepted/
- [queue overflow 30001: a send loop outruns one long code](./messaging-queue-overflow-30001/) — https://www.allanninal.dev/twilio/messaging-queue-overflow-30001/
- [an empty sender pool fails every send with error 21704](./messaging-service-empty-sender-pool/) — https://www.allanninal.dev/twilio/messaging-service-empty-sender-pool/
- [no status callback means delivery failures never reach you](./messaging-service-no-status-callback/) — https://www.allanninal.dev/twilio/messaging-service-no-status-callback/
- [a Messaging Service with no A2P campaign fails US sends](./messaging-service-not-a2p-registered/) — https://www.allanninal.dev/twilio/messaging-service-not-a2p-registered/
- [no Usage Trigger, so overspend runs with nothing watching](./no-usage-trigger-configured/) — https://www.allanninal.dev/twilio/no-usage-trigger-configured/
- [a number with an Application SID ignores its own voice_url](./number-conflicting-url-and-application-sid/) — https://www.allanninal.dev/twilio/number-conflicting-url-and-application-sid/
- [sends to recipients who texted STOP bounce with 21610](./opted-out-recipients-21610/) — https://www.allanninal.dev/twilio/opted-out-recipients-21610/
- [a rising share of outbound calls end in status failed](./outbound-call-failure-rate-spike/) — https://www.allanninal.dev/twilio/outbound-call-failure-rate-spike/
- [outbound messaging is off, so every send fails with 30037](./outbound-messaging-disabled-30037/) — https://www.allanninal.dev/twilio/outbound-messaging-disabled-30037/
- [number webhooks on http, a private address or a dev tunnel](./phone-number-insecure-or-unreachable-webhook-url/) — https://www.allanninal.dev/twilio/phone-number-insecure-or-unreachable-webhook-url/
- [a number with no fallback URL drops the call when yours 500s](./phone-number-missing-fallback-url/) — https://www.allanninal.dev/twilio/phone-number-missing-fallback-url/
- [a phone number still points at Twilio's demo TwiML](./phone-number-still-on-demo-twiml/) — https://www.allanninal.dev/twilio/phone-number-still-on-demo-twiml/
- [an approved regulatory bundle is counting down to expiry](./regulatory-bundle-expiring/) — https://www.allanninal.dev/twilio/regulatory-bundle-expiring/
- [REST concurrency exhausted, so bursts come back 20429](./rest-api-concurrency-exhausted/) — https://www.allanninal.dev/twilio/rest-api-concurrency-exhausted/
- [a short code used outside its own country fails 21612](./shortcode-cross-border-sender-mismatch/) — https://www.allanninal.dev/twilio/shortcode-cross-border-sender-mismatch/
- [a SIP Domain with no auth_type accepts no traffic at all](./sip-domain-no-auth-type/) — https://www.allanninal.dev/twilio/sip-domain-no-auth-type/
- [SMS Geo Permissions are off for the destination country](./sms-geo-permissions-disabled/) — https://www.allanninal.dev/twilio/sms-geo-permissions-disabled/
- [SMS Pumping Protection blocks legitimate OTPs with 30450](./sms-pumping-protection-30450/) — https://www.allanninal.dev/twilio/sms-pumping-protection-30450/
- [years-old API keys are still live with nobody owning them](./stale-or-orphaned-api-keys/) — https://www.allanninal.dev/twilio/stale-or-orphaned-api-keys/
- [status callback failures with 11200 leave delivery state blind](./status-callback-webhook-failing-11200/) — https://www.allanninal.dev/twilio/status-callback-webhook-failing-11200/
- [a Studio Flow left in draft, so your edits are live nowhere](./studio-flow-draft-not-published/) — https://www.allanninal.dev/twilio/studio-flow-draft-not-published/
- [a published Studio Flow that no phone number points at](./studio-flow-not-wired-to-number/) — https://www.allanninal.dev/twilio/studio-flow-not-wired-to-number/
- [a suspended subaccount, so one tenant's traffic 20005s](./subaccount-suspended-silently/) — https://www.allanninal.dev/twilio/subaccount-suspended-silently/
- [an unverified toll-free number is blocked, not throttled](./tollfree-number-not-verified/) — https://www.allanninal.dev/twilio/tollfree-number-not-verified/
- [a trial account rejects multi-segment messages with 30044](./trial-account-segment-limit-30044/) — https://www.allanninal.dev/twilio/trial-account-segment-limit-30044/
- [a SIP trunk with no disaster recovery URL loses every call](./trunk-missing-disaster-recovery-url/) — https://www.allanninal.dev/twilio/trunk-missing-disaster-recovery-url/
- [TwiML that is not well-formed XML fails with 12100](./twiml-document-parse-failure-12100/) — https://www.allanninal.dev/twilio/twiml-document-parse-failure-12100/
- [a TwiML response over 64 kB drops the call with 11750](./twiml-response-body-too-large-11750/) — https://www.allanninal.dev/twilio/twiml-response-body-too-large-11750/
- [one smart quote triples your segment count and your bill](./ucs2-segment-inflation/) — https://www.allanninal.dev/twilio/ucs2-segment-inflation/
- [recordings billed for storage until something deletes them](./unreleased-recordings-storage/) — https://www.allanninal.dev/twilio/unreleased-recordings-storage/
- [Verify conversion collapses in one country: SMS pumping](./verify-conversion-rate-collapse/) — https://www.allanninal.dev/twilio/verify-conversion-rate-collapse/
- [a Verify Service with zero rate limits configured](./verify-no-rate-limits/) — https://www.allanninal.dev/twilio/verify-no-rate-limits/
- [Verify sends SMS to a landline: 60205, or just silence](./verify-sms-to-landline/) — https://www.allanninal.dev/twilio/verify-sms-to-landline/
- [twilio cannot open a TCP connection to your webhook (11205)](./webhook-connection-timeout-11205/) — https://www.allanninal.dev/twilio/webhook-connection-timeout-11205/
- [a webhook hostname with no public DNS record fails with 11210](./webhook-dns-resolution-failure-11210/) — https://www.allanninal.dev/twilio/webhook-dns-resolution-failure-11210/
- [error 11206: Twilio cannot parse your webhook's HTTP response](./webhook-http-protocol-violation-11206/) — https://www.allanninal.dev/twilio/webhook-http-protocol-violation-11206/
- [a TwiML response with the wrong Content-Type fails with 12300](./webhook-invalid-content-type-12300/) — https://www.allanninal.dev/twilio/webhook-invalid-content-type-12300/
- [signature validation rejects Twilio with 403 behind a proxy](./webhook-signature-validation-403-behind-proxy/) — https://www.allanninal.dev/twilio/webhook-signature-validation-403-behind-proxy/
- [an expired webhook certificate fails every request with 11236](./webhook-tls-certificate-expired-11236/) — https://www.allanninal.dev/twilio/webhook-tls-certificate-expired-11236/
- [error 11237: your webhook sends a chain Twilio cannot verify](./webhook-tls-chain-untrusted-11237/) — https://www.allanninal.dev/twilio/webhook-tls-chain-untrusted-11237/
- [error 11220: the TLS handshake with your webhook never completes](./webhook-tls-handshake-failure-11220/) — https://www.allanninal.dev/twilio/webhook-tls-handshake-failure-11220/

## How to run one

Each folder holds the same script in Python and in Node.js, plus its test. Set the environment variables named in that folder's README and run it. Nothing writes, so there is no dry run to enable and no flag to be careful about — use a restricted, read-only credential and the worst case is that it tells you nothing is wrong.

## License

MIT. Use it, change it, ship it.
