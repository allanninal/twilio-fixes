# T-Mobile caps daily segments per brand, not per campaign

The morning batch is fine. The afternoon batch is fine. Somewhere around four o'clock deliveries to T-Mobile handsets stop, and by six every one of them is failing, while Verizon and AT&T carry on as if nothing happened. Tomorrow morning it works again. Nothing in your code changed, nothing in the Messaging Service changed, and the number that ran out is one you have never seen: a daily segment allowance held by T-Mobile against your brand.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/tmobile-brand-daily-segment-cap/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_tmobile_daily_cap_report.py
node node/twilio-tmobile-daily-cap-report.mjs
```

## Test it

```bash
pytest python/test_twilio_tmobile_daily_cap_report.py
node --test node/twilio-tmobile-daily-cap-report.test.mjs
```
