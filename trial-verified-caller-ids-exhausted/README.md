# the trial account's three verified numbers are spent

It works on your phone. It has always worked on your phone. A colleague joins the project, adds their number to the test list, and gets nothing at all &mdash; 21608, on a number that is switched on, in coverage, and perfectly capable of receiving messages from everyone else. Nothing changed in the code between the two runs. What changed is that the account had already spent the three verifications it was ever going to get.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/trial-verified-caller-ids-exhausted/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verified_caller_ids_audit.py
node node/twilio-verified-caller-ids-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verified_caller_ids_audit.py
node --test node/twilio-verified-caller-ids-audit.test.mjs
```
