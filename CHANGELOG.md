### 0.4.0
- Fix blocking start-up time.

### 0.3.0
- Add ability to ignore missing dependencies for the startup check.

### 0.2.1
- Fix the error not supporting yarn `nohoist`.
- Fix the error not recognizing yarn workspace symbolic links.
- Fix reporting the same problems unless the command is explicitly called.
- Amend information and error messages for better skimming.

### 0.2.0
- Add support of `package-lock.json` version 3.
- Amend information and error messages for better skimming.

### 0.1.1
- Fix the error accessing undefined.

### 0.1.0
- Reduce start-up time.

### 0.0.5
- Fix missing lock file because of path mismatched in macOS.

### 0.0.4
- Fix unexpected `package.json` in `node_modules` directory.
- Fix unexpected auto-checking on unchanged `package.json`.

### 0.0.3
- Fix cleaning up the module directories when the module version mismatched.

### 0.0.2
- Fix unexpected showing "The lock file was missing" when there were no dependencies written in the package.json file.

### 0.0.1
- Public release.
