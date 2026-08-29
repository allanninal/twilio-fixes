# error 30019: the MMS is too big for the carrier, not for Twilio

The image sends fine to your own phone. It sends fine to two of the three people who tested it. To the fourth it comes back undelivered with error_code 30019, content size exceeds carrier limit &mdash; and the file has not changed. Twilio's ceiling and the carrier's ceiling are different numbers, an order of magnitude apart, and only one of them rejects you up front.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/mms-content-size-exceeds-carrier-30019/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_mms_size_audit.py
node node/twilio-mms-size-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_mms_size_audit.py
node --test node/twilio-mms-size-audit.test.mjs
```
