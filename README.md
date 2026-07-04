# wgethub

This is a tool I made in like 30 minutes to help a friend. It's pretty basic but uh

```sh
./wgethub
```

Type in a GitHub username and repo name and then it runs wget to download it to the current directory.

## --no-validate

```sh
./wgethub -nv
```

Normally it sends 2 extra API requests to GitHub to verify if a repo exists, but if you add that it skips the validation and freaking dies if you typed it wrong

Why use -nv? Because GitHub rate limits you to 60 requests an hour.
**Without -nv:** probably like 3 requests
**With -nv:** 1 request

It's cool

## Compiling

Idk why you want to compile this but just use bun build or the npm builder thing idk look up how to build js files into executables or clone the repo and run it with node or bun yeaa
