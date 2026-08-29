# SMS to a landline fails with 30006 and retrying never helps

The same twelve numbers fail every night. error_code 30006, status undelivered, and a retry scheduled by a queue that assumes failures are temporary. They are not. Those numbers are desk phones, and no amount of retrying will make a desk phone receive an SMS &mdash; but you are billed for each attempt, and the customer is on your list as unreachable rather than as unreachable-by-this-channel.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/landline-destination-30006/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_landline_audit.py
node node/twilio-landline-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_landline_audit.py
node --test node/twilio-landline-audit.test.mjs
```
