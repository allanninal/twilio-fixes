import datetime

from twilio_api_key_audit import age_days, parse_date, verdict

NOW = datetime.datetime(2026, 8, 30, tzinfo=datetime.timezone.utc)


def make(**kw):
    key = {"sid": "SK00000000000000000000000000000001",
           "friendly_name": "billing-worker-prod",
           "date_created": "Sat, 01 Aug 2026 09:12:00 +0000",
           "date_updated": "Sat, 01 Aug 2026 09:12:00 +0000"}
    key.update(kw)
    return key


def test_the_2010_api_returns_rfc_2822_and_it_has_to_parse():
    parsed = parse_date("Tue, 18 Apr 2023 09:12:00 +0000")
    assert parsed == datetime.datetime(2023, 4, 18, 9, 12,
                                       tzinfo=datetime.timezone.utc)


def test_iso_8601_from_the_newer_domains_parses_too():
    parsed = parse_date("2023-04-18T09:12:00Z")
    assert parsed == datetime.datetime(2023, 4, 18, 9, 12,
                                       tzinfo=datetime.timezone.utc)


def test_an_unparseable_date_is_none_rather_than_a_wrong_answer():
    assert parse_date("last tuesday") is None
    assert parse_date("") is None
    assert parse_date(None) is None


def test_age_is_measured_in_whole_days_from_the_created_date():
    assert age_days(make(date_created="Thu, 30 Jul 2026 00:00:00 +0000"), NOW) == 31


def test_a_recently_created_named_key_is_current():
    state, _ = verdict(make(), NOW)
    assert state == "current"


def test_an_empty_friendly_name_is_unowned_whatever_its_age():
    state, detail = verdict(make(friendly_name="",
                                 date_created="Sat, 01 Aug 2026 09:12:00 +0000"), NOW)
    assert state == "unowned"
    assert "nobody can account for" in detail


def test_a_placeholder_name_counts_as_no_name():
    assert verdict(make(friendly_name="Untitled"), NOW)[0] == "unowned"
    assert verdict(make(friendly_name="  test  "), NOW)[0] == "unowned"


def test_a_key_named_after_its_own_sid_records_nothing():
    sid = "SK00000000000000000000000000000009"
    assert verdict(make(sid=sid, friendly_name=sid), NOW)[0] == "unowned"


def test_a_named_key_past_the_window_is_stale():
    state, detail = verdict(make(date_created="Wed, 15 Mar 2023 09:12:00 +0000",
                                 date_updated="Wed, 15 Mar 2023 09:12:00 +0000"),
                            NOW, max_age_days=365)
    assert state == "stale"
    assert "never moved" in detail


def test_date_updated_after_creation_is_a_rename_not_activity():
    # It moved, so the report drops the "never renamed" clause. It still says
    # nothing about whether the key has ever been used.
    state, detail = verdict(make(date_created="Wed, 15 Mar 2023 09:12:00 +0000",
                                 date_updated="Mon, 06 Jan 2025 11:00:00 +0000"),
                            NOW, max_age_days=365)
    assert state == "stale"
    assert "never moved" not in detail


def test_a_key_whose_date_will_not_parse_is_reported_not_skipped():
    state, detail = verdict(make(date_created="18/04/2023"), NOW)
    assert state == "undated"
    assert "RFC 2822" in detail
