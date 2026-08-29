# Fraud Guard blocked the prefix, so real users get 60410

Support has four tickets from one country, all saying the same thing: the code never arrives. Your logs show 60410, verification delivery attempt blocked. Nothing in the account changed, no carrier is down, and the numbers are ordinary mobiles. Fraud Guard is doing exactly what you asked it to do &mdash; it found pumping-shaped traffic on a number prefix and stopped sending there for twelve hours &mdash; and your real users happen to live on that prefix too.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/fraud-guard-blocking-prefix/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_fraud_guard_block_audit.py
node node/twilio-fraud-guard-block-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_fraud_guard_block_audit.py
node --test node/twilio-fraud-guard-block-audit.test.mjs
```
