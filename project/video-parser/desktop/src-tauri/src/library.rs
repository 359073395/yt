use super::*;

static JOURNAL_LOCK: Mutex<()> = Mutex::new(());
#[derive(Serialize, Deserialize)]
struct Journal { generation: u64, data: Value }

fn read_journal(root: &Path) -> Result<Option<Journal>, String> {
    let mut found = false;
    let mut valid = Vec::new();
    for slot in 0..2 {
        let path = root.join(format!("library.{slot}.json"));
        if path.exists() {
            found = true;
            if let Ok(bytes) = fs::read(path) {
                if let Ok(journal) = serde_json::from_slice::<Journal>(&bytes) { valid.push(journal); }
            }
        }
    }
    if found && valid.is_empty() { return Err("素材库记录无法读取；未覆盖原文件，请保留数据并检查磁盘".into()); }
    Ok(valid.into_iter().max_by_key(|entry| entry.generation))
}
fn write_journal(root: &Path, data: Value) -> Result<(), String> {
    if data["version"] != 1 || !data["items"].is_array() || !data["tasks"].is_array() || !data["categories"].is_array() { return Err("素材库格式无效".into()); }
    let generation = read_journal(root)?.map(|j| j.generation + 1).unwrap_or(1);
    let bytes = serde_json::to_vec(&Journal { generation, data }).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 { return Err("素材库超过 64 MB，请先归档旧任务；原记录未覆盖".into()); }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    // Alternating flushed snapshots: interruption never destroys the last valid generation.
    let mut file = File::create(root.join(format!("library.{}.json", generation % 2))).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| format!("素材库保存失败：{e}"))
}
#[tauri::command]
pub async fn library_load(app: tauri::AppHandle) -> Result<Value, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = JOURNAL_LOCK.lock().map_err(|_| "素材库忙")?;
        Ok(read_journal(&root)?.map(|j| j.data).unwrap_or(Value::Null))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn library_save(app: tauri::AppHandle, data: Value) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = JOURNAL_LOCK.lock().map_err(|_| "素材库忙")?;
        write_journal(&root, data)
    }).await.map_err(|e| e.to_string())?
}
pub fn category_path(root: &Path, category: &str) -> Result<PathBuf, String> {
    let normalized = category.trim().replace('\\', "/");
    let parts: Vec<_> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() > 5 { return Err("分类最多 5 层".into()); }
    let mut path = root.to_path_buf();
    for part in &parts {
        let name = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&name.as_str()) || (name.len() == 4 && (name.starts_with("COM") || name.starts_with("LPT")) && name.as_bytes()[3].is_ascii_digit());
        if *part == "." || *part == ".." || part.ends_with(['.', ' ']) || part.chars().count() > 60 || part.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) || reserved { return Err("分类名称不能用作文件夹".into()); }
        path.push(part);
    }
    if parts.is_empty() { path.push("待分类"); }
    Ok(path)
}
#[tauri::command]
pub fn read_bilingual(output_dir: String) -> Result<String, String> {
    let path = PathBuf::from(output_dir).join("双语文案.txt");
    let metadata = fs::metadata(&path).map_err(|_| "这条视频没有双语文案文件，请先生成文案")?;
    if metadata.len() > 2 * 1024 * 1024 { return Err("文案超过 2 MB，请打开文件夹查看".into()); }
    fs::read_to_string(path).map_err(|e| format!("无法读取文案：{e}"))
}
#[tauri::command]
pub fn relocate_output(output_dir: String, root: String, category: String) -> Result<String, String> {
    let source = fs::canonicalize(&output_dir).map_err(|e| format!("原文件夹不存在：{e}"))?;
    let base = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if !source.is_dir() || source == base || !source.starts_with(&base) { return Err("只允许移动当前保存根目录内的单条视频文件夹".into()); }
    if !source.file_name().and_then(|p| p.to_str()).map(|p| p.contains('[') && p.contains(']')).unwrap_or(false) { return Err("目录不是软件生成的单条视频文件夹，未移动".into()); }
    let category_root = category_path(&base, &category)?;
    fs::create_dir_all(&category_root).map_err(|e| e.to_string())?;
    let verified = fs::canonicalize(&category_root).map_err(|e| e.to_string())?;
    if !verified.starts_with(&base) { return Err("分类目录指向保存位置之外，未移动".into()); }
    let destination = verified.join(source.file_name().ok_or("文件夹名称无效")?);
    if destination == source { return Ok(visible_directory(&source)); }
    if destination.starts_with(&source) || destination.exists() { return Err("目标文件夹已存在或路径冲突；为保护已有文件，未覆盖".into()); }
    fs::rename(source, &destination).map_err(|e| format!("移动失败，原文件保留：{e}"))?;
    Ok(visible_directory(&destination))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn category_cannot_escape_root() {
        let root = Path::new("qa");
        for value in ["../private", "美妆/../private", "C:\\private", "CON", "abc.", "A/NUL.txt", "A/LPT1", "a/b/c/d/e/f"] { assert!(category_path(root, value).is_err(), "{value}"); }
        assert_eq!(category_path(root, "美妆/口播").unwrap(), root.join("美妆").join("口播"));
        assert_eq!(category_path(root, " ").unwrap(), root.join("待分类"));
    }
    #[test]
    fn torn_journal_retains_previous_generation() {
        let root = std::env::temp_dir().join(format!("paoliang-library-{}", uuid::Uuid::new_v4()));
        let data = serde_json::json!({"version":1,"items":[],"tasks":[],"categories":["美妆"]});
        write_journal(&root, data.clone()).unwrap();
        write_journal(&root, data.clone()).unwrap();
        fs::write(root.join("library.0.json"), b"{interrupted").unwrap();
        assert_eq!(read_journal(&root).unwrap().unwrap().data, data);
        fs::remove_file(root.join("library.0.json")).unwrap();
        fs::remove_file(root.join("library.1.json")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn moves_only_one_owned_video_folder_and_preserves_a_collision() {
        let root = std::env::temp_dir().join(format!("paoliang-move-{}", uuid::Uuid::new_v4()));
        let original = root.join("待分类").join("视频_[test]");
        fs::create_dir_all(&original).unwrap();
        fs::write(original.join("双语文案.txt"), "Hello\n你好").unwrap();
        let moved = relocate_output(original.to_string_lossy().into(), root.to_string_lossy().into(), "美妆/口播".into()).unwrap();
        assert!(!original.exists());
        assert_eq!(read_bilingual(moved.clone()).unwrap(), "Hello\n你好");
        fs::create_dir_all(&original).unwrap();
        assert!(relocate_output(moved.clone(), root.to_string_lossy().into(), "待分类".into()).is_err());
        assert!(Path::new(&moved).is_dir());
        assert!(relocate_output(moved.clone(), root.to_string_lossy().into(), "../outside".into()).is_err());
        fs::remove_file(Path::new(&moved).join("双语文案.txt")).unwrap();
        fs::remove_dir(&moved).unwrap();
        fs::remove_dir(root.join("美妆/口播")).unwrap();
        fs::remove_dir(root.join("美妆")).unwrap();
        fs::remove_dir(&original).unwrap();
        fs::remove_dir(root.join("待分类")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
