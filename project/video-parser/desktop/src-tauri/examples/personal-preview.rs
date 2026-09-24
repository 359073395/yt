fn main() {
    if std::env::var_os("PAOLIANG_NETWORK_QA").is_none() { std::env::set_var("YINGLIAN_PERSONAL_PREVIEW", "1"); }
    yinglian_desktop_lib::run();
}
