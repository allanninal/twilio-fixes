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
- [carrier filtering drops your SMS silently with error 30007](./carrier-filtered-messages-30007/) — https://www.allanninal.dev/twilio/carrier-filtered-messages-30007/
- [inbound SMS disappears into a number with no sms_url](./inbound-webhook-black-hole/) — https://www.allanninal.dev/twilio/inbound-webhook-black-hole/
- [SMS to a landline fails with 30006 and retrying never helps](./landline-destination-30006/) — https://www.allanninal.dev/twilio/landline-destination-30006/
- [messages stay queued or accepted and never reach a final state](./messages-stuck-queued-or-accepted/) — https://www.allanninal.dev/twilio/messages-stuck-queued-or-accepted/
- [a Messaging Service with no A2P campaign fails US sends](./messaging-service-not-a2p-registered/) — https://www.allanninal.dev/twilio/messaging-service-not-a2p-registered/
- [sends to recipients who texted STOP bounce with 21610](./opted-out-recipients-21610/) — https://www.allanninal.dev/twilio/opted-out-recipients-21610/
- [a number with no fallback URL drops the call when yours 500s](./phone-number-missing-fallback-url/) — https://www.allanninal.dev/twilio/phone-number-missing-fallback-url/
- [a phone number still points at Twilio's demo TwiML](./phone-number-still-on-demo-twiml/) — https://www.allanninal.dev/twilio/phone-number-still-on-demo-twiml/
- [an unverified toll-free number is blocked, not throttled](./tollfree-number-not-verified/) — https://www.allanninal.dev/twilio/tollfree-number-not-verified/

## How to run one

Each folder holds the same script in Python and in Node.js, plus its test. Set the environment variables named in that folder's README, keep `DRY_RUN=true` for the first pass, and read what it reports before letting it write.

## License

MIT. Use it, change it, ship it.
