import prompts from "prompts";
import { execSync } from "child_process";

let header = {
    // headers: {
    //     Authorization: "Bearer my api key replace this if you want idfk",
    // },
};
process.stdin.on("data", (key) => {
    if (key.toString() === "\x03") {
        process.stdout.write("\x1B[?25h\n");
        process.exit(0);
    }
});
(async () => {
    try {
        try {
            execSync("wget --version", { stdio: "ignore" });
        } catch {
            console.log("wget is not installed.");
            process.exit(0);
        }
        const user = await prompts({
            type: "text",
            name: "value",
            message: "GitHub Username",
            validate: async (value) => {
                if (
                    process.argv.includes("--no-validate") ||
                    process.argv.includes("-nv")
                )
                    return true;
                if (value.length == 0) return "Please type something.";
                let res = await fetch(
                    "https://api.github.com/users/" + value,
                    header,
                );
                res = await res.json();
                return res.status != "404"
                    ? true
                    : "Please enter a user that actually exists.";
            },
        });
        const repo = await prompts({
            type: "text",
            name: "value",
            message: "Repository Name",
            validate: async (value) => {
                if (
                    process.argv.includes("--no-validate") ||
                    process.argv.includes("-nv")
                )
                    return true;
                if (value.length == 0) return "Please type something.";
                let res = await fetch(
                    "https://api.github.com/repos/" + user.value + "/" + value,
                    header,
                );
                res = await res.json();
                return res.status != "404"
                    ? true
                    : "Please enter a repo that actually exists.";
            },
        });
        let versions = await fetch(
            "https://api.github.com/repos/" +
                user.value +
                "/" +
                repo.value +
                "/releases",
            header,
        );
        versions = await versions.json();
        if (versions.length == 0) {
            console.log("This repository has no releases.");
            process.exit(0);
        }
        versions = versions.map((v) => ({
            title: v.name,
            value: v,
        }));
        const version = await prompts({
            type: "autocomplete",
            name: "value",
            message: "Pick a release",
            choices: versions,
        });
        if (!version.value.assets) {
            console.log("This release has no assets.");
            process.exit(0);
        }
        let files = version.value.assets.map((f) => ({
            title: f.name,
            value: f.browser_download_url,
        }));
        const file = await prompts({
            type: "select",
            name: "value",
            message: "Pick a file",
            choices: files,
        });
        execSync("wget " + file.value);
    } catch (err) {
        console.log(
            "There was an error. Either GitHub reached a rate limit or you exited the program.",
            err,
        );
    }
})();
