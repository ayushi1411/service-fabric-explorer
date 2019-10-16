﻿import { DataModelBase, IDecorators } from './Base';
import { IRawClusterHealth, IRawHealthStateCount, IRawClusterManifest, IRawClusterUpgradeProgress, IRawClusterLoadInformation, IRawBackupPolicy } from '../RawDataTypes';
import { DataService } from 'src/app/services/data.service';
import { HealthStateFilterFlags } from '../HealthChunkRawDataTypes';
import { HealthStateConstants, StatusWarningLevel, BannerWarningID, UpgradeDomainStateRegexes, ClusterUpgradeStates, UpgradeDomainStateNames, CertExpiraryHealthEventProperty } from 'src/app/Common/Constants';
import { HealthEvaluation, UpgradeDomain, UpgradeDescription, LoadMetricInformation } from './Shared';
import { TimeUtils } from 'src/app/Utils/TimeUtils';
import { Utils } from 'src/app/Utils/Utils';
import { IResponseMessageHandler } from 'src/app/Common/ResponseMessageHandlers';
import { Node } from './Node';
import { HealthBase, HealthEvent } from './HealthEvent';
import { Observable, of } from 'rxjs';
import { mergeMap, map } from 'rxjs/operators';
import { CollectionUtils } from 'src/app/Utils/CollectionUtils';
import { HealthUtils } from 'src/app/Utils/healthUtils';

//-----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation.  All rights reserved.
// Licensed under the MIT License. See License file under the project root for license information.
//-----------------------------------------------------------------------------

export enum HealthStatisticsEntityKind {
    Node,
    Application,
    Service,
    Partition,
    Replica,
    DeployedApplication,
    DepoyedServicePackage
}

export class ClusterHealth extends HealthBase<IRawClusterHealth> {

    //make sure we only check once per session and this object will get destroyed/recreated
    private static certExpirationChecked = false;

    private emptyHealthStateCount: IRawHealthStateCount = {
        OkCount: 0,
        ErrorCount: 0,
        WarningCount: 0
    };

    public constructor(data: DataService,
        protected eventsHealthStateFilter: HealthStateFilterFlags,
        protected nodesHealthStateFilter: HealthStateFilterFlags,
        protected applicationsHealthStateFilter: HealthStateFilterFlags) {
        super(data);
    }

    public checkExpiredCertStatus() {
        try {
            if (!ClusterHealth.certExpirationChecked) {
            //Check cluster health
            //if healthy then no cert issue
            //if warning/Error
                //starting walking and query all seed nodes in warning state for cluster cert issues
                this.ensureInitialized().then( (clusterHealth: ClusterHealth) => {
                    clusterHealth = this;

                    if (clusterHealth.healthState.text === HealthStateConstants.Warning || clusterHealth.healthState.text === HealthStateConstants.Error) {
                        this.data.getNodes(true).then(nodes => {
                            let seedNodes = _.filter(nodes.collection, node => node.raw.IsSeedNode);
                            this.checkNodesContinually(0, seedNodes);
                        });
                    }
                });
            }
        }catch (e) {
            console.log(e);
        }
    }

    public getHealthStateCount(entityKind: HealthStatisticsEntityKind): IRawHealthStateCount {
        if (this.raw) {
            let entityHealthCount = _.find(this.raw.HealthStatistics.HealthStateCountList, item => item.EntityKind === HealthStatisticsEntityKind[entityKind]);
            if (entityHealthCount) {
                return entityHealthCount.HealthStateCount;
            }
        }
        return this.emptyHealthStateCount;
    }

    protected retrieveNewData(messageHandler?: IResponseMessageHandler): angular.IPromise<any> {
        return Utils.getHttpResponseData(this.data.restClient.getClusterHealth(this.eventsHealthStateFilter,
            this.nodesHealthStateFilter, this.applicationsHealthStateFilter,
            messageHandler));
    }

    private setMessage(healthEvent: HealthEvent): void {
        /*
        Example description for parsing reference(if this message changes this might need updating)
        Certificate expiration: thumbprint = 35d8f6bb4c52bd3f40a327a3094a9ee9692679ce, expiration = 2020-03-13 22:23:40.000
        , remaining lifetime is 213:8:17:08.174, please refresh ahead of time to avoid catastrophic failure.
        Warning threshold Security/CertificateExpirySafetyMargin is configured at 289:8:26:40.000, if needed, you can
        adjust it to fit your refresh process.

        */

        const thumbprintSearchText = "thumbprint = ";
        const thumbprintIndex = healthEvent.raw.Description.indexOf(thumbprintSearchText);
        const thumbprint =  healthEvent.raw.Description.substr(thumbprintIndex + thumbprintSearchText.length).split(",")[0];

        const expirationSearchText = "expiration = ";
        const expirationIndex = healthEvent.raw.Description.indexOf("expiration = ");
        const expiration = healthEvent.raw.Description.substring(expirationIndex + expirationSearchText.length).split(",")[0];

        this.data.warnings.addOrUpdateNotification({
            message: `A cluster certificate is set to expire soon. Replace it as soon as possible to avoid catastrophic failure. <br> Thumbprint : ${thumbprint}    Expiration: ${expiration}`,
            level: StatusWarningLevel.Error,
            priority: 5,
            id: BannerWarningID.ExpiringClusterCert,
            link: "https://aka.ms/sfrenewclustercert/",
            linkText: "Read here for more guidance"
        });
        ClusterHealth.certExpirationChecked = true;
    }

    private containsCertExpiringHealthEvent(unhealthyEvaluations: HealthEvent[]): HealthEvent[] {
        return unhealthyEvaluations.filter(event => event.raw.Description.indexOf("Certificate expiration") === 0 &&
                                            event.raw.Property === CertExpiraryHealthEventProperty.Cluster &&
                                            (event.raw.HealthState === HealthStateConstants.Warning || event.raw.HealthState === HealthStateConstants.Error));
    }

    private checkNodesContinually(index: number, nodes: Node[]) {
        if (index < nodes.length) {
            const node = nodes[index];
            if (node.healthState.text === HealthStateConstants.Error || node.healthState.text === HealthStateConstants.Warning) {
                node.health.ensureInitialized().then( () => {
                    const certExpiringEvents = this.containsCertExpiringHealthEvent(node.health.healthEvents);
                    if (certExpiringEvents.length === 0) {
                        this.checkNodesContinually(index + 1, nodes);
                    }else {
                        this.setMessage(certExpiringEvents[0]);
                    }
                });
            }else {
                this.checkNodesContinually(index + 1, nodes);
            }
        }else {
            ClusterHealth.certExpirationChecked = true;
        }
    }
}

export class ClusterManifest extends DataModelBase<IRawClusterManifest> {
    public clusterManifestName: string;
    private _imageStoreConnectionString: string;
    private _isNetworkInventoryManagerEnabled: boolean = false;

    public constructor(data: DataService) {
        super(data);
    }

    protected retrieveNewData(messageHandler?: IResponseMessageHandler): Observable<IRawClusterManifest> {
        return this.data.restClient.getClusterManifest(messageHandler);
    }

    protected updateInternal(): Observable<any> | void {
        //TODO fix xml parsing
        // let $xml = $($.parseXML(this.raw.Manifest));
        // let $manifest = $xml.find("ClusterManifest")[0];
        // this.clusterManifestName = $manifest.getAttribute("Name");
        // let $imageStoreConnectionStringParameter = $("Section[Name='Management'] > Parameter[Name='ImageStoreConnectionString']", $manifest);
        // if ($imageStoreConnectionStringParameter.length > 0) {
        //     this._imageStoreConnectionString = $imageStoreConnectionStringParameter.attr("Value");
        // }

        // let $nimEnabledParameter = $("Section[Name=NetworkInventoryManager] > Parameter[Name='IsEnabled']", $manifest);
        // if ($nimEnabledParameter.length > 0) {
        //     this._isNetworkInventoryManagerEnabled = $nimEnabledParameter.attr("Value").toLowerCase() === "true";
        // }
    }

    public get isNetworkInventoryManagerEnabled(): boolean {
        return this._isNetworkInventoryManagerEnabled;
    }

    public get imageStoreConnectionString(): string {
        return this._imageStoreConnectionString;
    }
}

export class ClusterUpgradeProgress extends DataModelBase<IRawClusterUpgradeProgress> {
    public decorators: IDecorators = {
        hideList: [
            // Unhealthy evaluations are displayed in separate section in app detail page
            "UnhealthyEvaluations"
        ],
        decorators: {
            "UpgradeDurationInMilliseconds": {
                displayName: (name) => "Upgrade Duration",
                displayValueInHtml: (value) => TimeUtils.getDuration(value)
            },
            "UpgradeDomainDurationInMilliseconds": {
                displayName: (name) => "Upgrade Domain Duration",
                displayValueInHtml: (value) => TimeUtils.getDuration(value)
            }
        }
    };

    public unhealthyEvaluations: HealthEvaluation[] = [];
    public upgradeDomains: UpgradeDomain[] = [];
    public upgradeDescription: UpgradeDescription;

    public get isUpgrading(): boolean {
        return UpgradeDomainStateRegexes.InProgress.test(this.raw.UpgradeState) || this.raw.UpgradeState === ClusterUpgradeStates.RollingForwardPending;
    }

    public get startTimestampUtc(): string {
        return TimeUtils.timestampToUTCString(this.raw.StartTimestampUtc);
    }

    public get failureTimestampUtc(): string {
        return TimeUtils.timestampToUTCString(this.raw.FailureTimestampUtc);
    }

    public get upgradeDuration(): string {
        return TimeUtils.getDuration(this.raw.UpgradeDurationInMilliseconds);
    }

    public get upgradeDomainDuration(): string {
        return TimeUtils.getDuration(this.raw.UpgradeDomainDurationInMilliseconds);
    }

    public getCompletedUpgradeDomains(): number {
        return this.upgradeDomains.filter(upgradeDomain => {return upgradeDomain.stateName === UpgradeDomainStateNames.Completed; }).length;
    }

    protected retrieveNewData(messageHandler?: IResponseMessageHandler): Observable<IRawClusterUpgradeProgress> {
        console.log("why")
        return this.data.restClient.getClusterUpgradeProgress(messageHandler).pipe(mergeMap( data => {
            if (data.CodeVersion === "0.0.0.0") {
                return this.data.restClient.getClusterVersion().pipe(map(resp => {
                    data.CodeVersion = resp.Version;
                    return data;
                }))
            }else {
                return of(data);
            }
        }))
    }

    protected updateInternal():Observable<any> | void {
        this.unhealthyEvaluations = HealthUtils.getParsedHealthEvaluations(this.raw.UnhealthyEvaluations, null, null, this.data);
        let domains = this.raw.UpgradeDomains.map(ud => new UpgradeDomain(this.data, ud));
        let groupedDomains = domains.filter(ud => ud.stateName === UpgradeDomainStateNames.Completed)
            .concat(domains.filter(ud => ud.stateName === UpgradeDomainStateNames.InProgress))
            .concat(domains.filter(ud => ud.name === this.raw.NextUpgradeDomain))
            .concat(domains.filter(ud => ud.stateName === UpgradeDomainStateNames.Pending && ud.name !== this.raw.NextUpgradeDomain));

        this.upgradeDomains = groupedDomains;

        if (this.raw.UpgradeDescription) {
            this.upgradeDescription = new UpgradeDescription(this.data, this.raw.UpgradeDescription);
        }
    }
}

export class ClusterLoadInformation extends DataModelBase<IRawClusterLoadInformation> {
    public loadMetricInformation: LoadMetricInformation[] = [];

    public get lastBalancingStartTimeUtc(): string {
        return TimeUtils.timestampToUTCString(this.raw.LastBalancingStartTimeUtc);
    }

    public get lastBalancingEndTimeUtc(): string {
        return TimeUtils.timestampToUTCString(this.raw.LastBalancingEndTimeUtc);
    }

    protected retrieveNewData(messageHandler?: IResponseMessageHandler): Observable<IRawClusterLoadInformation> {
        return this.data.restClient.getClusterLoadInformation(messageHandler);
    }

    protected updateInternal():Observable<any> | void {
        CollectionUtils.updateDataModelCollection(this.loadMetricInformation, this.raw.LoadMetricInformation.map(lmi => new LoadMetricInformation(this.data, lmi)));
    }
}
export class BackupPolicy extends DataModelBase<IRawBackupPolicy> {
    public decorators: IDecorators = {
        hideList: [
            "Name",
        ]
    };
    public action: ActionWithDialog;
    public updatePolicy: ActionWithDialog;

    public constructor(data: DataService, raw?: IRawBackupPolicy) {
        super(data, raw);
        this.action = new ActionWithDialog(
            data.$uibModal,
            data.$q,
            "deleteBackupPolicy",
            "Delete Backup Policy",
            "Deleting",
            () => data.restClient.deleteBackupPolicy(this.raw.Name),
            () => true,
            <angular.ui.bootstrap.IModalSettings>{
                templateUrl: "partials/backupPolicy.html",
                controller: ActionController,
                resolve: {
                    action: () => this
                }
            },
            null);

        this.updatePolicy = new ActionUpdateBackupPolicy(data, raw);
    }

    public updateBackupPolicy(): void {
        this.updatePolicy.runWithCallbacks.apply(this.updatePolicy);
    }
    protected retrieveNewData(messageHandler?: IResponseMessageHandler): angular.IPromise<IRawBackupPolicy> {
        return this.data.restClient.getBackupPolicy(this.name, messageHandler).then(response => {
            return response.data;
        });
    }
}
