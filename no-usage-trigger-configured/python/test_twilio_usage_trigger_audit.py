from twilio_usage_trigger_audit import suggested_cap, verdict


def make(**kw):
    trigger = {"sid": "UT01", "usage_category": "totalprice", "trigger_by": "price",
               "trigger_value": "250", "recurring": "daily",
               "callback_url": "https://ops.example.com/twilio-usage"}
    trigger.update(kw)
    return trigger


def test_an_account_with_no_triggers_is_the_worst_answer():
    state, detail = verdict([])
    assert state == "none"
    assert "nothing" in detail


def test_a_recurring_price_trigger_with_a_callback_is_coverage():
    state, _ = verdict([make()])
    assert state == "covered"


def test_a_one_shot_trigger_that_already_fired_is_a_spent_fuse():
    state, detail = verdict([make(recurring=None,
                                  date_fired="Tue, 18 Apr 2023 09:12:00 +0000")])
    assert state == "spent"
    assert "fuse" in detail


def test_a_one_shot_that_has_not_fired_yet_is_still_not_an_alarm():
    state, _ = verdict([make(recurring="")])
    assert state == "one-shot"


def test_a_recurring_trigger_with_no_callback_url_reaches_nobody():
    state, detail = verdict([make(callback_url="")])
    assert state == "no-callback"
    assert "on call" in detail


def test_price_triggers_on_a_category_but_not_on_totalprice():
    state, detail = verdict([make(usage_category="sms")])
    assert state == "category-only"
    assert "sms" in detail


def test_counting_messages_is_not_capping_money():
    state, detail = verdict([make(trigger_by="count")])
    assert state == "count-only"
    assert "premium" in detail


def test_one_live_price_trigger_outweighs_the_dead_ones_around_it():
    state, _ = verdict([make(recurring=None), make(callback_url=""), make()])
    assert state == "covered"


def test_suggested_cap_is_the_busiest_day_times_three():
    records = [{"price": "12.50"}, {"price": "40.00"}, {"price": "3.10"}]
    assert suggested_cap(records) == 120.0


def test_suggested_cap_falls_back_to_the_floor_on_a_quiet_account():
    assert suggested_cap([]) == 5.0
    assert suggested_cap([{"price": None}, {"price": "not a number"}]) == 5.0
