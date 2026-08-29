# Twilio Fixes

Read-only Python and Node.js scripts that find Twilio problems through the API — numbers left on demo TwiML, unregistered 10DLC campaigns, webhooks pointing nowhere and messages filtered by carriers. They report and print the repair; they never write.

Every fix is safe by default. The scripts start in a dry run mode that reports what they would do, so you can read the plan before anything writes.

By **[Allan Niñal](https://github.com/allanninal)** — AI Solutions Engineer. I build AI powered tools, data products, and AWS automation.
Full write ups with diagrams for each fix live at **[allanninal.dev/twilio](https://www.allanninal.dev/twilio/)**.

[![Follow on GitHub](https://img.shields.io/github/followers/allanninal?label=Follow%20%40allanninal&style=social)](https://github.com/allanninal)
## The fixes

- [an A2P brand stuck at FAILED blocks every campaign under it](./a2p-brand-registration-failed/) — https://www.allanninal.dev/twilio/a2p-brand-registration-failed/
- [an a2p campaign parked at IN_PROGRESS is not a live campaign](./a2p-campaign-stuck-in-progress/) — https://www.allanninal.dev/twilio/a2p-campaign-stuck-in-progress/
- [a2p campaign is FAILED and errors[] names the rejected field](./a2p-campaign-vetting-failed/) — https://www.allanninal.dev/twilio/a2p-campaign-vetting-failed/
- [error 21617: the rendered message body exceeds 1600 chars](./body-exceeds-1600-chars-21617/) — https://www.allanninal.dev/twilio/body-exceeds-1600-chars-21617/
- [carrier filtering drops your SMS silently with error 30007](./carrier-filtered-messages-30007/) — https://www.allanninal.dev/twilio/carrier-filtered-messages-30007/
- [recycled numbers send OTPs to whoever owns them now](./deactivated-number-recycling/) — https://www.allanninal.dev/twilio/deactivated-number-recycling/
- [a voice-only From number fails every SMS with error 21606](./from-number-not-sms-capable/) — https://www.allanninal.dev/twilio/from-number-not-sms-capable/
- [phone numbers with no traffic still bill every month](./idle-phone-numbers-billed/) — https://www.allanninal.dev/twilio/idle-phone-numbers-billed/
- [inbound SMS disappears into a number with no sms_url](./inbound-webhook-black-hole/) — https://www.allanninal.dev/twilio/inbound-webhook-black-hole/
- [SMS to a landline fails with 30006 and retrying never helps](./landline-destination-30006/) — https://www.allanninal.dev/twilio/landline-destination-30006/
- [messages stay queued or accepted and never reach a final state](./messages-stuck-queued-or-accepted/) — https://www.allanninal.dev/twilio/messages-stuck-queued-or-accepted/
- [queue overflow 30001: a send loop outruns one long code](./messaging-queue-overflow-30001/) — https://www.allanninal.dev/twilio/messaging-queue-overflow-30001/
- [an empty sender pool fails every send with error 21704](./messaging-service-empty-sender-pool/) — https://www.allanninal.dev/twilio/messaging-service-empty-sender-pool/
- [no status callback means delivery failures never reach you](./messaging-service-no-status-callback/) — https://www.allanninal.dev/twilio/messaging-service-no-status-callback/
- [a Messaging Service with no A2P campaign fails US sends](./messaging-service-not-a2p-registered/) — https://www.allanninal.dev/twilio/messaging-service-not-a2p-registered/
- [a number with an Application SID ignores its own voice_url](./number-conflicting-url-and-application-sid/) — https://www.allanninal.dev/twilio/number-conflicting-url-and-application-sid/
- [sends to recipients who texted STOP bounce with 21610](./opted-out-recipients-21610/) — https://www.allanninal.dev/twilio/opted-out-recipients-21610/
- [outbound messaging is off, so every send fails with 30037](./outbound-messaging-disabled-30037/) — https://www.allanninal.dev/twilio/outbound-messaging-disabled-30037/
- [a number with no fallback URL drops the call when yours 500s](./phone-number-missing-fallback-url/) — https://www.allanninal.dev/twilio/phone-number-missing-fallback-url/
- [a phone number still points at Twilio's demo TwiML](./phone-number-still-on-demo-twiml/) — https://www.allanninal.dev/twilio/phone-number-still-on-demo-twiml/
- [SMS Pumping Protection blocks legitimate OTPs with 30450](./sms-pumping-protection-30450/) — https://www.allanninal.dev/twilio/sms-pumping-protection-30450/
- [status callback failures with 11200 leave delivery state blind](./status-callback-webhook-failing-11200/) — https://www.allanninal.dev/twilio/status-callback-webhook-failing-11200/
- [an unverified toll-free number is blocked, not throttled](./tollfree-number-not-verified/) — https://www.allanninal.dev/twilio/tollfree-number-not-verified/
- [a trial account rejects multi-segment messages with 30044](./trial-account-segment-limit-30044/) — https://www.allanninal.dev/twilio/trial-account-segment-limit-30044/
- [one smart quote triples your segment count and your bill](./ucs2-segment-inflation/) — https://www.allanninal.dev/twilio/ucs2-segment-inflation/
- [twilio cannot open a TCP connection to your webhook (11205)](./webhook-connection-timeout-11205/) — https://www.allanninal.dev/twilio/webhook-connection-timeout-11205/
- [a webhook hostname with no public DNS record fails with 11210](./webhook-dns-resolution-failure-11210/) — https://www.allanninal.dev/twilio/webhook-dns-resolution-failure-11210/
- [an expired webhook certificate fails every request with 11236](./webhook-tls-certificate-expired-11236/) — https://www.allanninal.dev/twilio/webhook-tls-certificate-expired-11236/

## How to run one

Each folder holds the same script in Python and in Node.js, plus its test. Set the environment variables named in that folder's README, keep `DRY_RUN=true` for the first pass, and read what it reports before letting it write.

## License

MIT. Use it, change it, ship it.
