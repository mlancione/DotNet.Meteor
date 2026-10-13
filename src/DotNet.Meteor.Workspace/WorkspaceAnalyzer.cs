using DotNet.Meteor.Common;
using DotNet.Meteor.Common.Extensions;

namespace DotNet.Meteor.Workspace;

public static class WorkspaceAnalyzer {
    public static IEnumerable<Project> AnalyzeWorkspace(string workspacePath, Action<string>? callback = null) {
        var projects = new List<Project>();
        if (!Directory.Exists(workspacePath)) {
            callback?.Invoke($"Could not find workspace directory {workspacePath}");
            return projects;
        }

        foreach (var projectFile in Directory.EnumerateFiles(workspacePath, "*.*proj", SearchOption.AllDirectories)) {
            var project = AnalyzeProject(projectFile, callback);
            if (project == null)
                continue;
            projects.Add(project);
        }

        return projects.OrderBy(x => x.Name);
    }

    public static Project? AnalyzeProject(string projectFile, Action<string>? callback = null) {
        var project = new Project(projectFile);
        var outputType = project.EvaluateProperty("OutputType");

        if (outputType == null || outputType?.Contains("exe", StringComparison.OrdinalIgnoreCase) == false) {
            callback?.Invoke($"Skipping project {project.Name} because it is not an executable.");
            return null;
        }

        project.Configurations = GetConfigurations(project);
        project.Frameworks = GetTargetFrameworks(project);

        return project;
    }

    private static IEnumerable<string> GetTargetFrameworks(Project project) {
        var frameworks = new List<string>();

        // Discovery includes conditional assignments so every selectable target
        // is available. A single-target project can therefore yield a list too.
        var discoveredFrameworks = project.EvaluateProperty("TargetFramework");
        if (string.IsNullOrEmpty(discoveredFrameworks)) {
            discoveredFrameworks = project.EvaluateProperty("TargetFrameworks");
        }
        if (!string.IsNullOrEmpty(discoveredFrameworks)) {
            foreach (var framework in discoveredFrameworks.Split(';')) {
                if (frameworks.Contains(framework) || string.IsNullOrEmpty(framework))
                    continue;
                frameworks.Add(framework);
            }
            return frameworks;
        }

        return frameworks;
    }
    private static IEnumerable<string> GetConfigurations(Project project) {
        var configurations = new List<string>();

        var configurationsRaw = project.EvaluateProperty("Configurations", string.Empty) + ";Debug;Release";
        foreach (var configuration in configurationsRaw.Split(';')) {
            if (configurations.Contains(configuration) || string.IsNullOrEmpty(configuration))
                continue;
            configurations.Add(configuration);
        }

        return configurations.OrderBy(x => x).ToArray();
    }
}
