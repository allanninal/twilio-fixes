# Twilio Fixes

Read-only Python and Node.js scripts that find Twilio problems through the API — numbers left on demo TwiML, unregistered 10DLC campaigns, webhooks pointing nowhere and messages filtered by carriers. They report and print the repair; they never write.

Every fix is safe by default. The scripts start in a dry run mode that reports what they would do, so you can read the plan before anything writes.

By **[Allan Niñal](https://github.com/allanninal)** — AI Solutions Engineer. I build AI powered tools, data products, and AWS automation.
Full write ups with diagrams for each fix live at **[allanninal.dev/twilio](https://www.allanninal.dev/twilio/)**.

[![Follow on GitHub](https://img.shields.io/github/followers/allanninal?label=Follow%20%40allanninal&style=social)](https://github.com/allanninal)
## The fixes

- [inbound SMS disappears into a number with no sms_url](./inbound-webhook-black-hole/) — https://www.allanninal.dev/twilio/inbound-webhook-black-hole/
- [a Messaging Service with no A2P campaign fails US sends](./messaging-service-not-a2p-registered/) — https://www.allanninal.dev/twilio/messaging-service-not-a2p-registered/
- [a number with no fallback URL drops the call when yours 500s](./phone-number-missing-fallback-url/) — https://www.allanninal.dev/twilio/phone-number-missing-fallback-url/
- [a phone number still points at Twilio's demo TwiML](./phone-number-still-on-demo-twiml/) — https://www.allanninal.dev/twilio/phone-number-still-on-demo-twiml/

## How to run one

Each folder holds the same script in Python and in Node.js, plus its test. Set the environment variables named in that folder's README, keep `DRY_RUN=true` for the first pass, and read what it reports before letting it write.

## License

MIT. Use it, change it, ship it.
