# a Verify Service with zero rate limits configured

Verify looks protected. There is a limit on how often one phone number can be sent a code, and you have seen 60212 in the logs, so something is clearly throttling something. Then a scripted signup endpoint sends ten thousand verifications to ten thousand different numbers from a single host, hits no limit at all, and the invoice explains why: the protection you were relying on is keyed on the destination, and the attacker changes the destination every time.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/verify-no-rate-limits/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verify_rate_limit_audit.py
node node/twilio-verify-rate-limit-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verify_rate_limit_audit.py
node --test node/twilio-verify-rate-limit-audit.test.mjs
```
