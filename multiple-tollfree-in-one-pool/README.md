# two toll-free numbers in one sender pool get both blocked

Two toll-free numbers were put in one Messaging Service so the send would go faster. Both were verified. For a few weeks it did go faster. Then toll-free traffic through that service started failing with 30032 &mdash; across the whole pool, including the number that had been verified and sending since last year.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/multiple-tollfree-in-one-pool/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_tollfree_pool_audit.py
node node/twilio-tollfree-pool-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_tollfree_pool_audit.py
node --test node/twilio-tollfree-pool-audit.test.mjs
```
