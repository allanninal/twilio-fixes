# a trial account rejects multi-segment messages with 30044

&ldquo;Test&rdquo; sends. &ldquo;Your verification code is 481920&rdquo; sends. The real welcome message, the one with the customer's name and a link and a single cheerful emoji at the end, comes back undelivered with error_code=30044. Everyone's first theory is the link. It is not the link.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/trial-account-segment-limit-30044/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_trial_segment_audit.py
node node/twilio-trial-segment-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_trial_segment_audit.py
node --test node/twilio-trial-segment-audit.test.mjs
```
