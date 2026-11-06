from harness_daemon.osname import os_name


def test_windows_11_from_the_build_number():
    # Python 3.11 gives the release "10" on Windows 11.
    assert os_name("Windows", "10", "10.0.26300") == "Windows 11"
    assert os_name("Windows", "10", "10.0.22000") == "Windows 11"


def test_windows_10_stays():
    assert os_name("Windows", "10", "10.0.19045") == "Windows 10"
    assert os_name("Windows", "10", "") == "Windows 10"


def test_other_systems_and_new_python():
    assert os_name("Windows", "11", "10.0.26300") == "Windows 11"
    assert os_name("Linux", "6.8.0", "#1 SMP") == "Linux 6.8.0"


def test_this_computer():
    assert os_name().strip()
