# REST concurrency exhausted, so bursts come back 20429

The fan-out worked in staging with fifty recipients and fell over in production with fifty thousand. Not slowly: a wall of HTTP 429s with 20429 in the body, all at once, from a client that was doing nothing wrong except doing it all at the same moment. Retrying fixed it, which is exactly why the underlying number went unmeasured for another six months.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/rest-api-concurrency-exhausted/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_concurrency_probe.py
node node/twilio-concurrency-probe.mjs
```

## Test it

```bash
pytest python/test_twilio_concurrency_probe.py
node --test node/twilio-concurrency-probe.test.mjs
```
