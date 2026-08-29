# phone numbers with no traffic still bill every month

Nothing is broken. The invoice creeps up while message volume stays flat, and when somebody finally asks what the forty-one numbers on the account are for, the honest answer is that nobody knows. There is no error to search for, no alert to acknowledge &mdash; just a line item that has been quietly compounding since the last time anyone looked.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/idle-phone-numbers-billed/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_idle_numbers_audit.py
node node/twilio-idle-numbers-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_idle_numbers_audit.py
node --test node/twilio-idle-numbers-audit.test.mjs
```
